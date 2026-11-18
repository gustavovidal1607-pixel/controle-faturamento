// Guias enviadas, organizadas pelo mês do atendimento.
//   GET    /api/guias?acao=meses[&clinica=ID]              -> meses com contagem
//   GET    /api/guias?mes=AAAA-MM[&clinica=ID][&excluidas=1] -> guias do mês com anexos
//   DELETE /api/guias?id=ID                                 -> exclui a guia (e apaga os PDFs)
//
// Recepção só enxerga e mexe na própria clínica. A equipe Faturas Med
// escolhe a clínica (ou todas) e pode ver as excluídas.

const L = require('./_lib');

module.exports = L.rota(async (req, res) => {
  const u = await L.exigirUsuario(req, res);
  if (!u) return;
  const db = await L.prepararBanco();
  const p = L.parametros(req);

  // Recepção: sempre a própria clínica. Faturas: a escolhida ou todas (null).
  let clinica = null;
  if (u.perfil === 'recepcao') clinica = u.clinica_id;
  else if (/^\d+$/.test(p.get('clinica') || '')) clinica = Number(p.get('clinica'));

  if (req.method === 'GET' && p.get('acao') === 'meses'){
    const meses = await db.query(
      `SELECT competencia,
              count(*)::int AS total,
              count(*) FILTER (WHERE tipo = 'consulta')::int AS consultas,
              count(*) FILTER (WHERE tipo = 'honorario')::int AS honorarios,
              count(*) FILTER (WHERE baixado_em IS NULL)::int AS novas
         FROM guias
        WHERE excluido_em IS NULL AND ($1::int IS NULL OR clinica_id = $1)
        GROUP BY competencia
        ORDER BY competencia DESC`,
      [clinica]
    );
    return L.responder(res, 200, { meses, hoje: L.hojeBrasil() });
  }

  if (req.method === 'GET'){
    const mes = p.get('mes') || '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return L.responder(res, 400, { erro: 'Mês inválido.' });
    const comExcluidas = u.perfil === 'faturas' && p.get('excluidas') === '1';
    const guias = await db.query(
      `SELECT g.id, g.convenio, g.tipo, g.numero, to_char(g.data_atendimento, 'YYYY-MM-DD') AS data_atendimento,
              g.competencia, g.criado_em, g.baixado_em, g.excluido_em,
              g.clinica_id, c.nome AS clinica_nome,
              ue.nome AS enviado_por_nome, ux.nome AS excluido_por_nome,
              COALESCE((SELECT json_agg(json_build_object('id', a.id, 'nome', a.nome_original, 'tamanho', a.tamanho, 'doc', a.doc) ORDER BY a.id)
                          FROM anexos a WHERE a.guia_id = g.id), '[]'::json) AS anexos
         FROM guias g
         JOIN clinicas c ON c.id = g.clinica_id
         LEFT JOIN usuarios ue ON ue.id = g.enviado_por
         LEFT JOIN usuarios ux ON ux.id = g.excluido_por
        WHERE g.competencia = $1
          AND ($2::int IS NULL OR g.clinica_id = $2)
          AND ($3::boolean OR g.excluido_em IS NULL)
        ORDER BY g.data_atendimento DESC, g.id DESC`,
      [mes, clinica, comExcluidas]
    );
    return L.responder(res, 200, { guias, convenios: L.CONVENIOS });
  }

  if (req.method === 'DELETE'){
    const id = Number(p.get('id'));
    if (!Number.isInteger(id) || id <= 0) return L.responder(res, 400, { erro: 'Guia inválida.' });
    const [guia] = await db.query(
      `UPDATE guias SET excluido_em = now(), excluido_por = $2
        WHERE id = $1 AND excluido_em IS NULL AND ($3::int IS NULL OR clinica_id = $3)
        RETURNING id, numero`,
      [id, u.id, u.perfil === 'recepcao' ? u.clinica_id : null]
    );
    if (!guia) return L.responder(res, 404, { erro: 'Essa guia não existe mais ou já foi excluída.' });
    const anexos = await db.query(`DELETE FROM anexos WHERE guia_id = $1 RETURNING chave`, [id]);
    try { await L.apagarPdfs(anexos.map(a => a.chave)); }
    catch (e){ console.error('PDF da guia excluída não foi apagado do armazenamento:', id, e); }
    return L.responder(res, 200, { ok: true, numero: guia.numero });
  }

  return L.responder(res, 405, { erro: 'Método não permitido.' });
});
