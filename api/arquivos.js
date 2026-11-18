// PDFs das guias.
//
// Envio direto (produção, Vercel Blob): o navegador pede a conferência,
// sobe o PDF direto para o Blob (token de /api/upload) e depois registra:
//   POST /api/arquivos?acao=conferir   JSON { nova:{tipo,numero,data} } ou { guia:ID }
//   POST /api/arquivos?acao=registrar  JSON { chave, nome, tamanho, nova:{...} } ou { chave, nome, tamanho, guia:ID }
//
// Envio pelo servidor (modo local, sem Blob): o corpo é o próprio PDF.
//   POST /api/arquivos?acao=nova-guia&tipo=..&numero=..&data=AAAA-MM-DD&nome=..
//   POST /api/arquivos?guia=ID&nome=..
//
// Comum:
//   GET    /api/arquivos?id=ANEXO[&baixar=1]  -> abre/baixa o PDF
//   DELETE /api/arquivos?id=ANEXO             -> tira um PDF de honorário que tem mais de um

const L = require('./_lib');

module.exports = L.rota(async (req, res) => {
  const u = await L.exigirUsuario(req, res);
  if (!u) return;
  const db = await L.prepararBanco();
  const p = L.parametros(req);
  const acao = p.get('acao');

  if (req.method === 'POST'){
    if (u.perfil !== 'recepcao') return L.responder(res, 403, { erro: 'Só a recepção anexa guias.' });

    // ---- conferência antes de subir o PDF (envio direto)
    if (acao === 'conferir'){
      const corpo = await L.lerJson(req);
      const r = await conferirDestino(db, u, corpo);
      if (r.erro) return L.responder(res, r.status, { erro: r.erro });
      return L.responder(res, 200, { ok: true });
    }

    // ---- registro de um PDF que já está no Blob (envio direto)
    if (acao === 'registrar'){
      if (!L.uploadDireto()) return L.responder(res, 400, { erro: 'O envio direto não está ativo neste ambiente.' });
      const corpo = await L.lerJson(req);
      const chave = String(corpo.chave || '');
      if (!chave.startsWith(`clinica-${u.clinica_id}/`) || chave.includes('..')) return L.responder(res, 400, { erro: 'Arquivo inválido.' });
      const info = await L.infoPdf(chave);
      if (!info) return L.responder(res, 400, { erro: 'O PDF não chegou ao armazenamento. Tente enviar de novo.' });
      const r = await conferirDestino(db, u, corpo);
      if (r.erro){
        try { await L.apagarPdfs([chave]); } catch {}
        return L.responder(res, r.status, { erro: r.erro });
      }
      const nome = limparNome(corpo.nome);
      try {
        const saida = await salvar(db, u, r, { chave, nome, tamanho: info.size });
        return L.responder(res, 201, saida);
      } catch (e){
        try { await L.apagarPdfs([chave]); } catch {}
        if (e && e.code === '23505') return L.responder(res, 409, { erro: (await guiaRepetida(db, u.clinica_id, r.nova.tipo, r.nova.numero)) || 'Essa guia já foi enviada.' });
        throw e;
      }
    }

    // ---- envio pelo servidor (modo local): o corpo é o PDF
    let pdf;
    try { pdf = await L.lerCorpo(req, L.LIMITE_PDF); }
    catch (e){
      if (e.codigo === 'GRANDE') return L.responder(res, 413, { erro: 'O arquivo é grande demais para este caminho de envio. Atualize a página e tente de novo.' });
      throw e;
    }
    if (!L.ehPdf(pdf)) return L.responder(res, 400, { erro: 'O arquivo não é um PDF. Anexe a guia escaneada em PDF.' });
    const nome = limparNome(p.get('nome'));
    const destino = acao === 'nova-guia'
      ? { nova: { tipo: p.get('tipo'), numero: p.get('numero'), data: p.get('data') } }
      : { guia: p.get('guia') };
    const r = await conferirDestino(db, u, destino);
    if (r.erro) return L.responder(res, r.status, { erro: r.erro });
    try {
      return L.responder(res, 201, await salvar(db, u, r, { pdf, nome }));
    } catch (e){
      if (e && e.code === '23505') return L.responder(res, 409, { erro: (await guiaRepetida(db, u.clinica_id, r.nova.tipo, r.nova.numero)) || 'Essa guia já foi enviada.' });
      throw e;
    }
  }

  if (req.method === 'GET' || req.method === 'DELETE'){
    const id = Number(p.get('id'));
    if (!Number.isInteger(id) || id <= 0) return L.responder(res, 400, { erro: 'Anexo inválido.' });
    const [anexo] = await db.query(
      `SELECT a.id, a.chave, a.guia_id, g.tipo, g.numero, to_char(g.data_atendimento, 'DD-MM-YYYY') AS data_br,
              (SELECT count(*)::int FROM anexos x WHERE x.guia_id = g.id) AS qtd,
              (SELECT count(*)::int FROM anexos x WHERE x.guia_id = g.id AND x.id <= a.id) AS ordem
         FROM anexos a JOIN guias g ON g.id = a.guia_id
        WHERE a.id = $1 AND g.excluido_em IS NULL AND ($2::int IS NULL OR g.clinica_id = $2)`,
      [id, u.perfil === 'recepcao' ? u.clinica_id : null]
    );
    if (!anexo) return L.responder(res, 404, { erro: 'Esse PDF não existe mais.' });

    if (req.method === 'DELETE'){
      if (u.perfil !== 'recepcao') return L.responder(res, 403, { erro: 'Só a recepção mexe nos anexos.' });
      if (anexo.qtd <= 1) return L.responder(res, 400, { erro: 'É o único PDF da guia. Para tirar, exclua a guia inteira.' });
      await db.query(`DELETE FROM anexos WHERE id = $1`, [id]);
      try { await L.apagarPdfs([anexo.chave]); } catch (e){ console.error('PDF não apagado do armazenamento:', id, e); }
      return L.responder(res, 200, { ok: true });
    }

    const conteudo = await L.lerPdf(anexo.chave);
    if (!conteudo) return L.responder(res, 404, { erro: 'O PDF não foi encontrado no armazenamento.' });
    // Equipe Faturas Med abriu/baixou: a guia deixa de ser "nova".
    if (u.perfil === 'faturas') await db.query(`UPDATE guias SET baixado_em = now() WHERE id = $1 AND baixado_em IS NULL`, [anexo.guia_id]);

    const nomeArquivo = `${anexo.tipo === 'consulta' ? 'CONSULTA' : 'HONORARIO'}_${anexo.numero}_${anexo.data_br}${anexo.qtd > 1 ? '_' + anexo.ordem : ''}.pdf`;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', conteudo.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${p.get('baixar') === '1' ? 'attachment' : 'inline'}; filename="${nomeArquivo}"`);
    return res.end(conteudo);
  }

  return L.responder(res, 405, { erro: 'Método não permitido.' });
});

// Confere para onde o PDF vai: guia nova (tipo/número/data válidos e não
// repetida) ou guia de honorário existente com espaço. Devolve
// { nova:{tipo,numero,data} } | { guia:{...} } ou { erro, status }.
async function conferirDestino(db, u, corpo){
  if (corpo.nova){
    const tipo = corpo.nova.tipo;
    if (tipo !== 'consulta' && tipo !== 'honorario') return { erro: 'Escolha se a guia é de consulta ou de honorário.', status: 400 };
    const numero = limparNumero(corpo.nova.numero);
    if (!numero) return { erro: 'Digite o número da guia (só números e letras, até 30 caracteres).', status: 400 };
    const data = String(corpo.nova.data || '');
    const erroData = conferirData(data);
    if (erroData) return { erro: erroData, status: 400 };
    const repetida = await guiaRepetida(db, u.clinica_id, tipo, numero);
    if (repetida) return { erro: repetida, status: 409 };
    return { nova: { tipo, numero, data } };
  }
  const guiaId = Number(corpo.guia);
  if (!Number.isInteger(guiaId) || guiaId <= 0) return { erro: 'Guia inválida.', status: 400 };
  const [guia] = await db.query(
    `SELECT g.id, g.tipo, g.numero, g.competencia, (SELECT count(*)::int FROM anexos a WHERE a.guia_id = g.id) AS qtd
       FROM guias g WHERE g.id = $1 AND g.clinica_id = $2 AND g.excluido_em IS NULL`,
    [guiaId, u.clinica_id]
  );
  if (!guia) return { erro: 'Essa guia não existe mais ou foi excluída.', status: 404 };
  if (guia.tipo !== 'honorario' && guia.qtd >= 1) return { erro: 'Guia de consulta leva só um PDF. Se o PDF está errado, exclua a guia e envie de novo.', status: 400 };
  if (guia.qtd >= L.MAX_ANEXOS_HONORARIO) return { erro: `Essa guia já tem ${L.MAX_ANEXOS_HONORARIO} PDFs, que é o máximo.`, status: 400 };
  return { guia };
}

// Grava guia (se nova) + anexo. `arquivo` é { pdf, nome } (sobe daqui) ou
// { chave, nome, tamanho } (já está no armazenamento).
async function salvar(db, u, destino, arquivo){
  if (destino.nova){
    const { tipo, numero, data } = destino.nova;
    const [guia] = await db.query(
      `INSERT INTO guias (clinica_id, tipo, numero, data_atendimento, competencia, enviado_por)
       VALUES ($1, $2, $3, $4::date, $5, $6) RETURNING id`,
      [u.clinica_id, tipo, numero, data, data.slice(0, 7), u.id]
    );
    try {
      await gravarAnexo(db, { clinicaId: u.clinica_id, guiaId: guia.id, competencia: data.slice(0, 7), tipo, numero, ordem: 1 }, arquivo);
    } catch (e){
      await db.query(`DELETE FROM guias WHERE id = $1`, [guia.id]);
      throw e;
    }
    return { ok: true, guia_id: guia.id, competencia: data.slice(0, 7) };
  }
  const g = destino.guia;
  await gravarAnexo(db, { clinicaId: u.clinica_id, guiaId: g.id, competencia: g.competencia, tipo: g.tipo, numero: g.numero, ordem: g.qtd + 1 }, arquivo);
  return { ok: true, guia_id: g.id, competencia: g.competencia };
}

async function gravarAnexo(db, g, arquivo){
  let chave = arquivo.chave, tamanho = arquivo.tamanho;
  if (!chave){
    const sufixo = require('crypto').randomBytes(4).toString('hex');
    chave = await L.guardarPdf(`clinica-${g.clinicaId}/${g.competencia}/${g.tipo}-${g.numero.replace(/[^A-Za-z0-9-]/g, '_')}-g${g.guiaId}-${g.ordem}-${sufixo}.pdf`, arquivo.pdf);
    tamanho = arquivo.pdf.length;
  }
  await db.query(
    `INSERT INTO anexos (guia_id, nome_original, tamanho, chave) VALUES ($1, $2, $3, $4)`,
    [g.guiaId, arquivo.nome, tamanho, chave]
  );
}

async function guiaRepetida(db, clinicaId, tipo, numero){
  const [g] = await db.query(
    `SELECT to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS enviada,
            to_char(data_atendimento, 'DD/MM/YYYY') AS atendimento
       FROM guias WHERE clinica_id = $1 AND tipo = $2 AND numero = $3 AND excluido_em IS NULL`,
    [clinicaId, tipo, numero]
  );
  if (!g) return null;
  return `A guia ${numero} (${tipo === 'consulta' ? 'consulta' : 'honorário'}, atendimento ${g.atendimento}) já foi enviada em ${g.enviada}. Se a anterior estava errada, exclua ela antes de enviar de novo.`;
}

function limparNumero(valor){
  const n = String(valor || '').replace(/\s+/g, '').toUpperCase();
  return /^[0-9A-Z./-]{1,30}$/.test(n) ? n : '';
}

function limparNome(valor){
  const n = String(valor || 'guia.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 150);
  return n || 'guia.pdf';
}

function conferirData(data){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return 'Digite a data do atendimento.';
  const d = new Date(data + 'T12:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== data) return 'A data do atendimento não existe. Confira dia e mês.';
  if (data > L.hojeBrasil()) return 'A data do atendimento não pode ser depois de hoje.';
  if (data < '2020-01-01') return 'A data do atendimento está muito antiga. Confira o ano.';
  return null;
}
