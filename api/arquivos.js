// PDFs das guias. O corpo da requisição é o próprio PDF (um por vez).
//   POST   /api/arquivos?acao=nova-guia&tipo=consulta|honorario&numero=..&data=AAAA-MM-DD&nome=..
//          -> cria a guia já com o primeiro PDF (guia nunca fica sem anexo)
//   POST   /api/arquivos?guia=ID&nome=..   -> mais um PDF numa guia de honorário
//   GET    /api/arquivos?id=ANEXO[&baixar=1] -> abre/baixa o PDF
//   DELETE /api/arquivos?id=ANEXO          -> tira um PDF de honorário que tem mais de um

const L = require('./_lib');

module.exports = L.rota(async (req, res) => {
  const u = await L.exigirUsuario(req, res);
  if (!u) return;
  const db = await L.prepararBanco();
  const p = L.parametros(req);

  if (req.method === 'POST'){
    if (u.perfil !== 'recepcao') return L.responder(res, 403, { erro: 'Só a recepção anexa guias.' });

    let pdf;
    try { pdf = await L.lerCorpo(req, L.LIMITE_PDF); }
    catch (e){
      if (e.codigo === 'GRANDE') return L.responder(res, 413, { erro: 'O arquivo passa de 4 MB. Escaneie com resolução menor (200 dpi, preto e branco) e tente de novo.' });
      throw e;
    }
    if (!L.ehPdf(pdf)) return L.responder(res, 400, { erro: 'O arquivo não é um PDF. Anexe a guia escaneada em PDF.' });
    const nome = limparNome(p.get('nome'));

    // ---- guia nova (primeiro PDF)
    if (p.get('acao') === 'nova-guia'){
      const tipo = p.get('tipo');
      if (tipo !== 'consulta' && tipo !== 'honorario') return L.responder(res, 400, { erro: 'Escolha se a guia é de consulta ou de honorário.' });
      const numero = limparNumero(p.get('numero'));
      if (!numero) return L.responder(res, 400, { erro: 'Digite o número da guia (só números e letras, até 30 caracteres).' });
      const data = p.get('data') || '';
      const erroData = conferirData(data);
      if (erroData) return L.responder(res, 400, { erro: erroData });

      const repetida = await guiaRepetida(db, u.clinica_id, tipo, numero);
      if (repetida) return L.responder(res, 409, { erro: repetida });

      let guia;
      try {
        [guia] = await db.query(
          `INSERT INTO guias (clinica_id, tipo, numero, data_atendimento, competencia, enviado_por)
           VALUES ($1, $2, $3, $4::date, $5, $6) RETURNING id`,
          [u.clinica_id, tipo, numero, data, data.slice(0, 7), u.id]
        );
      } catch (e){
        if (e && e.code === '23505') return L.responder(res, 409, { erro: (await guiaRepetida(db, u.clinica_id, tipo, numero)) || 'Essa guia já foi enviada.' });
        throw e;
      }

      try {
        await gravarAnexo(db, u.clinica_id, guia.id, data.slice(0, 7), tipo, numero, 1, nome, pdf);
      } catch (e){
        await db.query(`DELETE FROM guias WHERE id = $1`, [guia.id]);
        throw e;
      }
      return L.responder(res, 201, { ok: true, guia_id: guia.id, competencia: data.slice(0, 7) });
    }

    // ---- mais um PDF numa guia de honorário
    const guiaId = Number(p.get('guia'));
    if (!Number.isInteger(guiaId) || guiaId <= 0) return L.responder(res, 400, { erro: 'Guia inválida.' });
    const [guia] = await db.query(
      `SELECT g.id, g.tipo, g.numero, g.competencia, (SELECT count(*)::int FROM anexos a WHERE a.guia_id = g.id) AS qtd
         FROM guias g WHERE g.id = $1 AND g.clinica_id = $2 AND g.excluido_em IS NULL`,
      [guiaId, u.clinica_id]
    );
    if (!guia) return L.responder(res, 404, { erro: 'Essa guia não existe mais ou foi excluída.' });
    if (guia.tipo !== 'honorario' && guia.qtd >= 1) return L.responder(res, 400, { erro: 'Guia de consulta leva só um PDF. Se o PDF está errado, exclua a guia e envie de novo.' });
    if (guia.qtd >= L.MAX_ANEXOS_HONORARIO) return L.responder(res, 400, { erro: `Essa guia já tem ${L.MAX_ANEXOS_HONORARIO} PDFs, que é o máximo.` });
    await gravarAnexo(db, u.clinica_id, guia.id, guia.competencia, guia.tipo, guia.numero, guia.qtd + 1, nome, pdf);
    return L.responder(res, 201, { ok: true, guia_id: guia.id });
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

async function gravarAnexo(db, clinicaId, guiaId, competencia, tipo, numero, ordem, nome, pdf){
  // Sufixo aleatório: tirar e pôr anexo de novo nunca sobrescreve outro PDF.
  const sufixo = require('crypto').randomBytes(4).toString('hex');
  const chave = `clinica-${clinicaId}/${competencia}/${tipo}-${numero.replace(/[^A-Za-z0-9-]/g, '_')}-g${guiaId}-${ordem}-${sufixo}.pdf`;
  const guardado = await L.guardarPdf(chave, pdf);
  await db.query(
    `INSERT INTO anexos (guia_id, nome_original, tamanho, chave) VALUES ($1, $2, $3, $4)`,
    [guiaId, nome, pdf.length, guardado]
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
