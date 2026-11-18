// Módulo interno (o "_" na frente faz a Vercel não publicar como rota).
// Junta tudo que as rotas usam: banco, armazenamento dos PDFs, sessão e
// leitura/resposta de requisição.
//
// Dois modos, escolhidos sozinhos pelas variáveis de ambiente:
//  - ONLINE (Vercel): DATABASE_URL (Neon/Postgres) + BLOB_READ_WRITE_TOKEN
//    (Vercel Blob, loja PRIVADA). Os PDFs nunca ficam com link público.
//  - LOCAL (teste no PC): sem essas variáveis, o banco é um Postgres
//    embutido (PGlite) e os PDFs vão para a pasta dados-local/.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Envio pelo servidor: na Vercel a função não recebe mais que 4,5 MB (por
// isso lá o PDF vai direto para o Blob); no PC não há esse limite.
const LIMITE_PDF = process.env.BLOB_READ_WRITE_TOKEN ? 4 * 1024 * 1024 : 300 * 1024 * 1024;
const LIMITE_PDF_DIRETO = 100 * 1024 * 1024; // teto de segurança do envio direto
const MAX_ANEXOS_HONORARIO = 10;
const HORAS_SESSAO = 12;
const PASTA_LOCAL = path.join(__dirname, '..', 'dados-local');

// ---------------------------------------------------------------- banco

let dbPromise = null;
function conectar(){
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (url){
      const { neon } = require('@neondatabase/serverless');
      const sql = neon(url);
      return { query: (texto, params = []) => sql.query(texto, params) };
    }
    const { PGlite } = await import('@electric-sql/pglite');
    fs.mkdirSync(PASTA_LOCAL, { recursive: true });
    const pg = new PGlite(path.join(PASTA_LOCAL, 'banco'));
    return { query: async (texto, params = []) => (await pg.query(texto, params)).rows };
  })();
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

let esquemaPronto = null;
function prepararBanco(){
  if (esquemaPronto) return esquemaPronto;
  esquemaPronto = (async () => {
    const db = await conectar();
    await db.query(`CREATE TABLE IF NOT EXISTS clinicas (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL UNIQUE,
      ativa BOOLEAN NOT NULL DEFAULT true,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      perfil TEXT NOT NULL CHECK (perfil IN ('recepcao','faturas')),
      clinica_id INT REFERENCES clinicas(id),
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT true,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Guarda só o hash do token: quem ler o banco não consegue entrar.
    await db.query(`CREATE TABLE IF NOT EXISTS sessoes (
      token_hash TEXT PRIMARY KEY,
      usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      expira_em TIMESTAMPTZ NOT NULL
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS tentativas_login (
      login TEXT NOT NULL,
      quando TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // competencia = mês do atendimento (AAAA-MM): é por ela que as guias
    // ficam organizadas. Excluir não apaga a linha (fica o registro de
    // quem excluiu e quando), só o PDF.
    await db.query(`CREATE TABLE IF NOT EXISTS guias (
      id SERIAL PRIMARY KEY,
      clinica_id INT NOT NULL REFERENCES clinicas(id),
      tipo TEXT NOT NULL CHECK (tipo IN ('consulta','honorario')),
      numero TEXT NOT NULL,
      data_atendimento DATE NOT NULL,
      competencia CHAR(7) NOT NULL,
      enviado_por INT REFERENCES usuarios(id),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      baixado_em TIMESTAMPTZ,
      excluido_em TIMESTAMPTZ,
      excluido_por INT REFERENCES usuarios(id)
    )`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS guias_numero_unico
      ON guias (clinica_id, tipo, numero) WHERE excluido_em IS NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS guias_por_mes ON guias (clinica_id, competencia)`);
    await db.query(`CREATE TABLE IF NOT EXISTS anexos (
      id SERIAL PRIMARY KEY,
      guia_id INT NOT NULL REFERENCES guias(id) ON DELETE CASCADE,
      nome_original TEXT NOT NULL,
      tamanho INT NOT NULL,
      chave TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS anexos_por_guia ON anexos (guia_id)`);

    // Primeiro acesso da equipe: se ainda não existe ninguém da Faturas,
    // cria a conta com ADMIN_LOGIN / ADMIN_SENHA (variáveis de ambiente).
    const senhaAdmin = process.env.ADMIN_SENHA;
    if (senhaAdmin){
      const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM usuarios WHERE perfil = 'faturas'`);
      if (n === 0){
        const login = normalizarLogin(process.env.ADMIN_LOGIN || 'admin');
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await hashSenha(senhaAdmin, salt);
        await db.query(
          `INSERT INTO usuarios (login, nome, perfil, salt, hash) VALUES ($1, $2, 'faturas', $3, $4)
           ON CONFLICT (login) DO NOTHING`,
          [login, process.env.ADMIN_NOME || 'Faturas Med', salt, hash]
        );
      }
    }
    return db;
  })();
  esquemaPronto.catch(() => { esquemaPronto = null; });
  return esquemaPronto;
}

// ---------------------------------------------------------------- senhas e sessão

function hashSenha(senha, salt){
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(senha), salt, 64, (err, chave) => err ? reject(err) : resolve(chave.toString('hex')));
  });
}

async function conferirSenha(senha, salt, hashGuardado){
  const a = Buffer.from(await hashSenha(senha, salt), 'hex');
  const b = Buffer.from(hashGuardado, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizarLogin(login){
  return String(login || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]/g, '');
}

function hashToken(token){
  return crypto.createHash('sha256').update(token).digest('hex');
}

const COOKIE = 'cf_sessao';

function lerCookies(req){
  const saida = {};
  String(req.headers.cookie || '').split(';').forEach(par => {
    const i = par.indexOf('=');
    if (i > 0) saida[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  });
  return saida;
}

function ehHttps(req){
  return String(req.headers['x-forwarded-proto'] || '').includes('https');
}

async function abrirSessao(req, res, usuarioId){
  const db = await prepararBanco();
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [hashToken(token), usuarioId, String(HORAS_SESSAO)]
  );
  // Aproveita para limpar sessões vencidas.
  await db.query(`DELETE FROM sessoes WHERE expira_em < now()`);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${HORAS_SESSAO * 3600}${ehHttps(req) ? '; Secure' : ''}`);
}

async function fecharSessao(req, res){
  const token = lerCookies(req)[COOKIE];
  if (token){
    const db = await prepararBanco();
    await db.query(`DELETE FROM sessoes WHERE token_hash = $1`, [hashToken(token)]);
  }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${ehHttps(req) ? '; Secure' : ''}`);
}

async function usuarioDaSessao(req){
  const token = lerCookies(req)[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const db = await prepararBanco();
  const linhas = await db.query(
    `SELECT u.id, u.login, u.nome, u.perfil, u.clinica_id, c.nome AS clinica_nome
       FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN clinicas c ON c.id = u.clinica_id
      WHERE s.token_hash = $1 AND s.expira_em > now() AND u.ativo
        AND (u.perfil = 'faturas' OR c.ativa)`,
    [hashToken(token)]
  );
  return linhas[0] || null;
}

// Devolve o usuário logado ou responde 401/403 e devolve null.
async function exigirUsuario(req, res, perfil){
  const u = await usuarioDaSessao(req);
  if (!u){ responder(res, 401, { erro: 'Sua sessão terminou. Entre de novo.' }); return null; }
  if (perfil && u.perfil !== perfil){ responder(res, 403, { erro: 'Este acesso não permite essa ação.' }); return null; }
  return u;
}

// ---------------------------------------------------------------- requisição / resposta

function parametros(req){
  return new URL(req.url, 'http://local').searchParams;
}

function lerCorpo(req, limite){
  // Na Vercel o corpo já vem lido em req.body (Buffer para
  // application/octet-stream, objeto para JSON, string para texto) e o
  // fluxo não pode mais ser lido. No PC (dev-server) req.body não existe.
  let pronto;
  try { pronto = req.body; } catch { pronto = undefined; }
  if (pronto !== undefined && pronto !== null){
    const buf = Buffer.isBuffer(pronto) ? pronto
      : typeof pronto === 'string' ? Buffer.from(pronto, 'utf8')
      : Buffer.from(JSON.stringify(pronto), 'utf8');
    if (buf.length > limite) return Promise.reject(Object.assign(new Error('grande'), { codigo: 'GRANDE' }));
    return Promise.resolve(buf);
  }
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let estourou = false;
    req.on('data', parte => {
      if (estourou) return;
      total += parte.length;
      if (total > limite){ estourou = true; reject(Object.assign(new Error('grande'), { codigo: 'GRANDE' })); return; }
      partes.push(parte);
    });
    req.on('end', () => { if (!estourou) resolve(Buffer.concat(partes)); });
    req.on('error', reject);
  });
}

async function lerJson(req){
  try { if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body; } catch {}
  const corpo = await lerCorpo(req, 100 * 1024);
  if (!corpo.length) return {};
  try { return JSON.parse(corpo.toString('utf8')); } catch { return {}; }
}

function responder(res, status, dados){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(dados));
}

// Envolve a rota: qualquer erro inesperado vira 500 com mensagem simples
// (o detalhe vai só para o log).
function rota(fn){
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e){
      console.error(e);
      if (!res.headersSent) responder(res, 500, { erro: 'Algo deu errado no servidor. Tente de novo em instantes.' });
    }
  };
}

// ---------------------------------------------------------------- PDFs

const usaBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

async function guardarPdf(chave, conteudo){
  if (usaBlob()){
    const { put } = require('@vercel/blob');
    const r = await put(chave, conteudo, { access: 'private', contentType: 'application/pdf', addRandomSuffix: true });
    return r.pathname;
  }
  const destino = path.join(PASTA_LOCAL, 'arquivos', chave);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, conteudo);
  return chave;
}

async function lerPdf(chave){
  if (usaBlob()){
    const { get } = require('@vercel/blob');
    const r = await get(chave, { access: 'private' });
    if (!r || r.statusCode !== 200) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  }
  const origem = path.join(PASTA_LOCAL, 'arquivos', chave);
  return fs.existsSync(origem) ? fs.readFileSync(origem) : null;
}

// Confere se o PDF existe no armazenamento e devolve { size }.
async function infoPdf(chave){
  if (usaBlob()){
    const { head } = require('@vercel/blob');
    try { const r = await head(chave); return r ? { size: r.size } : null; }
    catch { return null; }
  }
  const origem = path.join(PASTA_LOCAL, 'arquivos', chave);
  return fs.existsSync(origem) ? { size: fs.statSync(origem).size } : null;
}

async function apagarPdfs(chaves){
  if (!chaves.length) return;
  if (usaBlob()){
    const { del } = require('@vercel/blob');
    await del(chaves);
    return;
  }
  for (const chave of chaves){
    try { fs.unlinkSync(path.join(PASTA_LOCAL, 'arquivos', chave)); } catch {}
  }
}

function ehPdf(conteudo){
  return conteudo.length > 5 && conteudo.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

// ---------------------------------------------------------------- datas (horário de Brasília)

function hojeBrasil(){
  // en-CA formata como AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

module.exports = {
  LIMITE_PDF, LIMITE_PDF_DIRETO, MAX_ANEXOS_HONORARIO,
  prepararBanco, hashSenha, conferirSenha, normalizarLogin,
  abrirSessao, fecharSessao, usuarioDaSessao, exigirUsuario,
  parametros, lerCorpo, lerJson, responder, rota,
  guardarPdf, lerPdf, infoPdf, apagarPdfs, ehPdf, hojeBrasil,
  uploadDireto: usaBlob,
};
