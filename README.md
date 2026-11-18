# Controle de Faturamento — Faturas Med

Portal onde a **recepção da clínica** anexa as guias (PDF) e a **equipe Faturas Med** baixa tudo organizado por mês para faturar.

## Como funciona

- **Entrada**: abertura com a logo, depois login com dois perfis — *Recepção da clínica* e *Equipe Faturas Med*.
- **Recepção** (vê só a própria clínica):
  1. escolhe **Consulta** (um PDF) ou **Honorário** (até 10 PDFs);
  2. digita **número da guia** e **data do atendimento**;
  3. anexa o PDF (arrastar ou escolher) e clica em **Enviar guia** — uma guia por vez.
  - A guia entra na aba do **mês do atendimento**.
  - Pode **excluir** uma guia errada e enviar de novo. Em honorário pode tirar um PDF ou juntar mais (**+ PDF**).
  - O mesmo número não entra duas vezes no mesmo tipo (avisa que já foi enviada).
- **Equipe Faturas Med**: escolhe a clínica, vê as guias por mês, abre/baixa PDF (a guia passa de *Nova* para *Aberta*), baixa selecionadas ou o mês inteiro em **.zip** (pastas CONSULTAS/HONORARIOS), vê as excluídas, e em **Clínicas e acessos** cadastra clínicas e cria/redefine/desativa logins.

## Rodar no PC (teste)

```
npm install
node dev-server.js
```

Abre em http://localhost:3000. Sem variáveis de ambiente usa um banco embutido e grava os PDFs em `dados-local/`. Primeiro acesso da equipe: usuário `admin`, senha `teste123` (só no modo local).

## Colocar no ar (Vercel + Neon + Blob)

1. Subir esta pasta para um repositório no GitHub e importar na Vercel (framework: *Other*).
2. Na Vercel, em **Storage**, criar um **Blob store** com acesso **Private** e ligar ao projeto (isso já cria `BLOB_READ_WRITE_TOKEN`).
3. Criar um banco no [neon.tech](https://neon.tech) e cadastrar `DATABASE_URL` nas variáveis do projeto.
4. Cadastrar `ADMIN_LOGIN`, `ADMIN_NOME` e `ADMIN_SENHA` (ver `.env.example`) — é o primeiro login da equipe; as tabelas são criadas sozinhas no primeiro acesso.
5. Deploy. Depois: entrar como *Equipe Faturas Med* → **Clínicas e acessos** → cadastrar a clínica e criar o usuário da recepção (o sistema mostra usuário e senha para passar à clínica).

Limites: 10 PDFs por guia de honorário, sessão de 12 horas, PDF até 100 MB (teto de segurança). Em produção o PDF vai do navegador **direto para o Blob** (`js/vendor/blob-client.js`, token emitido por `api/upload.js`), porque uma função da Vercel só aceita 4,5 MB de requisição; depois o navegador registra a guia em `/api/arquivos?acao=registrar`. No modo local o PDF passa pelo servidor.

Para regenerar `js/vendor/blob-client.js` depois de atualizar `@vercel/blob`:
```
npx esbuild node_modules/@vercel/blob/dist/client.js --bundle --platform=browser --format=iife --global-name=VercelBlob --minify --outfile=js/vendor/blob-client.js
```

## Estrutura

- `api/_lib.js` — banco (Neon ou PGlite local), PDFs (Vercel Blob privado ou pasta local), sessão por cookie HttpOnly, utilitários.
- `api/auth.js` — entrar/sair/quem sou/trocar senha (trava após 8 senhas erradas em 15 min).
- `api/arquivos.js` — envio, abertura, download e remoção de PDFs.
- `api/guias.js` — meses, lista do mês, exclusão de guia.
- `api/admin.js` — clínicas e acessos (só equipe).
- `index.html`, `css/app.css`, `js/app.js`, `js/zip.js` — telas, sem build.
- `dev-server.js` — servidor local de teste que roda as mesmas rotas.
