// Clínicas e acessos — só a equipe Faturas Med.
//   GET  /api/admin?acao=dados
//   POST /api/admin?acao=clinica          { nome }
//   POST /api/admin?acao=clinica-editar   { id, nome?, ativa? }
//   POST /api/admin?acao=usuario          { login, nome, perfil, clinica_id?, senha }
//   POST /api/admin?acao=usuario-editar   { id, nome?, ativo?, senha?, clinica_id? }

const crypto = require('crypto');
const L = require('./_lib');

module.exports = L.rota(async (req, res) => {
  const u = await L.exigirUsuario(req, res, 'faturas');
  if (!u) return;
  const db = await L.prepararBanco();
  const acao = L.parametros(req).get('acao');

  if (req.method === 'GET' && acao === 'dados'){
    const clinicas = await db.query(
      `SELECT c.id, c.nome, c.ativa,
              (SELECT count(*)::int FROM usuarios x WHERE x.clinica_id = c.id AND x.ativo) AS usuarios,
              (SELECT count(*)::int FROM guias g WHERE g.clinica_id = c.id AND g.excluido_em IS NULL) AS guias
         FROM clinicas c ORDER BY c.ativa DESC, c.nome`
    );
    const usuarios = await db.query(
      `SELECT u.id, u.login, u.nome, u.perfil, u.clinica_id, c.nome AS clinica_nome, u.ativo, u.criado_em
         FROM usuarios u LEFT JOIN clinicas c ON c.id = u.clinica_id
        ORDER BY u.ativo DESC, u.perfil, c.nome NULLS FIRST, u.nome`
    );
    return L.responder(res, 200, { clinicas, usuarios, eu: u.id });
  }

  if (req.method !== 'POST') return L.responder(res, 405, { erro: 'Método não permitido.' });
  const corpo = await L.lerJson(req);

  if (acao === 'clinica'){
    const nome = String(corpo.nome || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!nome) return L.responder(res, 400, { erro: 'Digite o nome da clínica.' });
    const [existe] = await db.query(`SELECT id FROM clinicas WHERE lower(nome) = lower($1)`, [nome]);
    if (existe) return L.responder(res, 409, { erro: 'Já existe uma clínica com esse nome.' });
    const [c] = await db.query(`INSERT INTO clinicas (nome) VALUES ($1) RETURNING id`, [nome]);
    return L.responder(res, 201, { ok: true, id: c.id });
  }

  if (acao === 'clinica-editar'){
    const id = Number(corpo.id);
    const [c] = await db.query(`SELECT * FROM clinicas WHERE id = $1`, [id]);
    if (!c) return L.responder(res, 404, { erro: 'Clínica não encontrada.' });
    const nome = corpo.nome !== undefined ? String(corpo.nome).trim().replace(/\s+/g, ' ').slice(0, 120) : c.nome;
    if (!nome) return L.responder(res, 400, { erro: 'Digite o nome da clínica.' });
    const ativa = corpo.ativa !== undefined ? !!corpo.ativa : c.ativa;
    await db.query(`UPDATE clinicas SET nome = $1, ativa = $2 WHERE id = $3`, [nome, ativa, id]);
    if (!ativa) await db.query(`DELETE FROM sessoes WHERE usuario_id IN (SELECT id FROM usuarios WHERE clinica_id = $1)`, [id]);
    return L.responder(res, 200, { ok: true });
  }

  if (acao === 'usuario'){
    const login = L.normalizarLogin(corpo.login);
    const nome = String(corpo.nome || '').trim().slice(0, 120);
    const perfil = corpo.perfil === 'faturas' ? 'faturas' : 'recepcao';
    const senha = String(corpo.senha || '');
    if (!login || login.length < 3) return L.responder(res, 400, { erro: 'O usuário precisa de pelo menos 3 letras ou números (sem espaço).' });
    if (!nome) return L.responder(res, 400, { erro: 'Digite o nome da pessoa.' });
    if (senha.length < 6) return L.responder(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    let clinicaId = null;
    if (perfil === 'recepcao'){
      clinicaId = Number(corpo.clinica_id);
      const [c] = await db.query(`SELECT id FROM clinicas WHERE id = $1 AND ativa`, [clinicaId]);
      if (!c) return L.responder(res, 400, { erro: 'Escolha a clínica dessa recepção.' });
    }
    const [existe] = await db.query(`SELECT id FROM usuarios WHERE login = $1`, [login]);
    if (existe) return L.responder(res, 409, { erro: `O usuário "${login}" já existe. Escolha outro.` });
    const salt = crypto.randomBytes(16).toString('hex');
    await db.query(
      `INSERT INTO usuarios (login, nome, perfil, clinica_id, salt, hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [login, nome, perfil, clinicaId, salt, await L.hashSenha(senha, salt)]
    );
    return L.responder(res, 201, { ok: true, login });
  }

  if (acao === 'usuario-editar'){
    const id = Number(corpo.id);
    const [alvo] = await db.query(`SELECT * FROM usuarios WHERE id = $1`, [id]);
    if (!alvo) return L.responder(res, 404, { erro: 'Usuário não encontrado.' });
    if (corpo.ativo === false && alvo.id === u.id) return L.responder(res, 400, { erro: 'Você não pode desativar o seu próprio acesso.' });

    const nome = corpo.nome !== undefined ? String(corpo.nome).trim().slice(0, 120) : alvo.nome;
    if (!nome) return L.responder(res, 400, { erro: 'Digite o nome da pessoa.' });
    const novaSenha = corpo.senha !== undefined && corpo.senha !== '' ? String(corpo.senha) : null;
    if (novaSenha !== null && novaSenha.length < 6) return L.responder(res, 400, { erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    const ativo = corpo.ativo !== undefined ? !!corpo.ativo : alvo.ativo;
    let clinicaId = alvo.clinica_id;
    if (alvo.perfil === 'recepcao' && corpo.clinica_id !== undefined){
      clinicaId = Number(corpo.clinica_id);
      const [c] = await db.query(`SELECT id FROM clinicas WHERE id = $1`, [clinicaId]);
      if (!c) return L.responder(res, 400, { erro: 'Clínica não encontrada.' });
    }
    await db.query(`UPDATE usuarios SET nome = $1, ativo = $2, clinica_id = $3 WHERE id = $4`, [nome, ativo, clinicaId, id]);

    if (novaSenha !== null){
      const salt = crypto.randomBytes(16).toString('hex');
      await db.query(`UPDATE usuarios SET salt = $1, hash = $2 WHERE id = $3`, [salt, await L.hashSenha(novaSenha, salt), id]);
      await db.query(`DELETE FROM tentativas_login WHERE login = $1`, [alvo.login]);
    }
    // Senha trocada, desativado ou mudou de clínica: derruba as sessões abertas.
    if (!ativo || clinicaId !== alvo.clinica_id || (novaSenha !== null && id !== u.id)){
      await db.query(`DELETE FROM sessoes WHERE usuario_id = $1`, [id]);
    }
    return L.responder(res, 200, { ok: true });
  }

  return L.responder(res, 400, { erro: 'Ação desconhecida.' });
});
