// Controle de Faturamento — telas (recepção e equipe Faturas Med)
(function(){
  'use strict';

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const MESES_CURTO = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
  const LIMITE_PDF = 100 * 1024 * 1024; // teto de segurança
  const MAX_ANEXOS = 10;

  const estado = {
    usuario: null,
    direto: false,        // true = PDF vai do navegador direto para o armazenamento (produção)
    aba: 'guias',
    mes: null,            // AAAA-MM selecionado
    meses: [],
    guias: [],
    clinica: '',          // só Faturas: '' = todas
    filtroTipo: 'todas',
    busca: '',
    verExcluidas: false,
    selecionadas: new Set(),
    destacar: null,       // id da guia recém-enviada
    admin: null,          // { clinicas, usuarios }
  };

  // ---------------------------------------------------------------- utilidades
  function hojeISO(){
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const dataBR = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
  const mesNome = comp => `${MESES[Number(comp.slice(5, 7)) - 1]} de ${comp.slice(0, 4)}`;
  function quandoBR(ts){
    if (!ts) return '';
    const d = new Date(ts);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} às ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const tamanhoBR = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  const tipoNome = t => t === 'consulta' ? 'Consulta' : 'Honorário';
  const nomePdf = (g, i, total) => `${g.tipo === 'consulta' ? 'CONSULTA' : 'HONORARIO'}_${g.numero}_${dataBR(g.data_atendimento).replace(/\//g, '-')}${total > 1 ? '_' + (i + 1) : ''}.pdf`;

  function aviso(texto, erro){
    const el = document.createElement('div');
    el.className = 'aviso' + (erro ? ' erro-aviso' : '');
    el.textContent = texto;
    $('#avisos').appendChild(el);
    setTimeout(() => { el.classList.add('some'); setTimeout(() => el.remove(), 350); }, erro ? 7000 : 4000);
  }

  async function api(url, opcoes = {}){
    const r = await fetch(url, { credentials: 'same-origin', ...opcoes, headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) } });
    let dados = {};
    try { dados = await r.json(); } catch {}
    if (r.status === 401 && estado.usuario){
      estado.usuario = null;
      mostrarLogin('Sua sessão terminou. Entre de novo.');
      throw new Error(dados.erro || 'Sessão encerrada.');
    }
    if (!r.ok) throw new Error(dados.erro || 'Não foi possível concluir. Tente de novo.');
    return dados;
  }

  // Diálogo genérico: confirmar(opções) -> true/false
  function confirmar({ titulo, texto, botao = 'Confirmar', perigo = false }){
    return new Promise(resolve => {
      const dlg = $('#dialogo');
      dlg.innerHTML = `
        <form method="dialog">
          <h2>${h(titulo)}</h2>
          <p>${texto}</p>
          <div class="rodape-dialogo">
            <button type="button" class="botao fantasma" value="nao">Cancelar</button>
            <button type="submit" class="botao ${perigo ? 'perigo' : 'primario'}" value="sim">${h(botao)}</button>
          </div>
        </form>`;
      $('button[value=nao]', dlg).onclick = () => dlg.close('nao');
      dlg.onclose = () => resolve(dlg.returnValue === 'sim');
      dlg.showModal();
    });
  }

  // ---------------------------------------------------------------- abertura
  async function abertura(){
    const caixa = $('#abertura-logo');
    try {
      const svg = await (await fetch('img/logo.svg')).text();
      caixa.innerHTML = svg;
    } catch { caixa.innerHTML = '<img src="img/logo.svg" alt="Faturas Med">'; }
    const tela = $('#abertura');
    const foto = $('.abertura-foto', tela);
    // Espera a foto estar pronta (no máximo 1,5 s) para a sequência não
    // começar com o fundo vazio.
    await Promise.race([foto.decode().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
    requestAnimationFrame(() => tela.classList.add('animar'));
    // A sequência inteira dura ~3,4 s; segura mais um pouco no final.
    // Um clique na tela pula a espera.
    let pular;
    const espera = new Promise(r => { pular = r; setTimeout(r, 4300); });
    tela.addEventListener('click', () => pular(), { once: true });
    let usuario = null;
    try { const r = await api('/api/auth?acao=eu'); usuario = r.usuario; estado.direto = !!r.direto; } catch {}
    await espera;
    if (usuario) entrar(usuario); else mostrarLogin();
    tela.classList.add('saindo');
    setTimeout(() => tela.remove(), 600);
  }

  // ---------------------------------------------------------------- login
  let perfilLogin = 'recepcao';
  function mostrarLogin(mensagem){
    $('#app').hidden = true;
    const tela = $('#tela-login');
    tela.hidden = false;
    $('#login-erro').textContent = mensagem || '';
    $('#login-senha').value = '';
    setTimeout(() => $('#login-usuario').focus(), 50);
  }

  function definirPerfilLogin(p){
    perfilLogin = p;
    $$('.seletor-perfil button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.perfil === p)));
    $('#login-dica').textContent = p === 'recepcao'
      ? 'Entre com o usuário da recepção para anexar as guias.'
      : 'Acesso da equipe FaturasMed: ver e baixar as guias para faturar.';
  }

  $$('.seletor-perfil button').forEach(b => b.addEventListener('click', () => definirPerfilLogin(b.dataset.perfil)));

  $('#form-login').addEventListener('submit', async ev => {
    ev.preventDefault();
    const botao = $('button[type=submit]', ev.target);
    const erro = $('#login-erro');
    erro.textContent = '';
    botao.disabled = true; botao.textContent = 'Entrando…';
    try {
      const r = await fetch('/api/auth?acao=entrar', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: $('#login-usuario').value, senha: $('#login-senha').value, perfil: perfilLogin }),
      });
      const dados = await r.json().catch(() => ({}));
      if (!r.ok){
        if (dados.perfilCerto) definirPerfilLogin(dados.perfilCerto);
        erro.textContent = dados.erro || 'Não foi possível entrar.';
        return;
      }
      $('#login-senha').value = '';
      estado.direto = !!dados.direto;
      entrar(dados.usuario);
    } catch {
      erro.textContent = 'Sem conexão com o servidor. Confira a internet e tente de novo.';
    } finally {
      botao.disabled = false; botao.textContent = 'Entrar';
    }
  });

  // ---------------------------------------------------------------- entrada no sistema
  function entrar(usuario){
    estado.usuario = usuario;
    estado.mes = null; estado.meses = []; estado.guias = []; estado.selecionadas.clear();
    $('#tela-login').hidden = true;
    $('#app').hidden = false;
    $('#topo-nome').textContent = usuario.nome;
    $('#topo-local').textContent = usuario.perfil === 'recepcao' ? usuario.clinica_nome : 'Equipe Faturas Med';
    $('#topo-abas').hidden = usuario.perfil !== 'faturas';
    estado.aba = 'guias';
    renderizar();
  }

  $('#btn-sair').addEventListener('click', async () => {
    try { await api('/api/auth?acao=sair', { method: 'POST' }); } catch {}
    estado.usuario = null;
    mostrarLogin();
  });

  $('#topo-abas').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-aba]');
    if (!b) return;
    estado.aba = b.dataset.aba;
    $$('#topo-abas button').forEach(x => x === b ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current'));
    renderizar();
  });

  $('#btn-senha').addEventListener('click', () => {
    const dlg = $('#dialogo');
    dlg.innerHTML = `
      <form id="form-senha">
        <h2>Trocar minha senha</h2>
        <label class="campo"><span>Senha atual</span><input type="password" name="atual" autocomplete="current-password" required></label>
        <label class="campo"><span>Nova senha</span><input type="password" name="nova" autocomplete="new-password" minlength="6" required><small>Pelo menos 6 caracteres.</small></label>
        <label class="campo"><span>Repita a nova senha</span><input type="password" name="nova2" autocomplete="new-password" required></label>
        <p class="erro" role="alert"></p>
        <div class="rodape-dialogo">
          <button type="button" class="botao fantasma" data-fechar>Cancelar</button>
          <button type="submit" class="botao primario">Salvar nova senha</button>
        </div>
      </form>`;
    $('[data-fechar]', dlg).onclick = () => dlg.close();
    dlg.onclose = null;
    $('#form-senha').onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target, erro = $('.erro', f);
      if (f.nova.value !== f.nova2.value){ erro.textContent = 'As duas senhas novas não são iguais.'; return; }
      try {
        await api('/api/auth?acao=senha', { method: 'POST', body: JSON.stringify({ atual: f.atual.value, nova: f.nova.value }) });
        dlg.close(); aviso('Senha trocada.');
      } catch (e){ erro.textContent = e.message; }
    };
    dlg.showModal();
  });

  // ---------------------------------------------------------------- renderização principal
  function renderizar(){
    const u = estado.usuario;
    const c = $('#conteudo');
    if (u.perfil === 'recepcao'){
      c.innerHTML = `<div class="mesa">${painelAnexar()}<section class="arquivo" id="arquivo"></section></div>`;
      ligarPainelAnexar();
    } else if (estado.aba === 'acessos'){
      c.innerHTML = `<div class="acessos" id="acessos"><div class="carregando">Carregando…</div></div>`;
      carregarAcessos();
      return;
    } else {
      c.innerHTML = `<div id="barra-clinica"></div><section class="arquivo" id="arquivo"></section>`;
      renderizarBarraClinica();
    }
    carregarMeses();
  }

  // ---------------------------------------------------------------- recepção: anexar
  function painelAnexar(){
    return `
    <section class="painel anexar" aria-labelledby="anexar-titulo">
      <h2 id="anexar-titulo">Anexar guia</h2>
      <p class="sub">Uma guia por vez.</p>
      <form id="form-anexar" novalidate>
        <fieldset class="passo">
          <legend><span class="passo-n">1</span> É uma guia de:</legend>
          <div class="tipos">
            <label class="tipo">
              <input type="radio" name="tipo" value="consulta">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
              <span><strong>Consulta</strong><small>Um PDF</small></span>
            </label>
            <label class="tipo">
              <input type="radio" name="tipo" value="honorario">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="16" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/><path d="M7 11h6M7 15h6"/></svg>
              <span><strong>Honorário</strong><small>Vários PDFs</small></span>
            </label>
          </div>
        </fieldset>

        <fieldset class="passo" id="passo-dados" disabled>
          <legend><span class="passo-n">2</span> Dados da guia</legend>
          <div class="dupla">
            <label class="campo"><span>Número da guia</span><input name="numero" inputmode="text" autocomplete="off" maxlength="30" placeholder="Ex.: 12345678"></label>
            <label class="campo"><span>Data do atendimento</span><input name="data" type="date" max="${hojeISO()}" min="2020-01-01"></label>
          </div>
        </fieldset>

        <fieldset class="passo" id="passo-pdf" disabled>
          <legend><span class="passo-n">3</span> <span id="rotulo-pdf">PDF da guia</span></legend>
          <label class="soltar" id="soltar">
            <input type="file" name="pdf" accept="application/pdf,.pdf">
            <strong>Arraste o PDF aqui ou <u>escolha o arquivo</u></strong>
            <small id="dica-pdf">Só PDF.</small>
          </label>
          <ul class="arquivos" id="lista-arquivos"></ul>
        </fieldset>

        <div class="envio">
          <p class="erro" id="erro-anexar" role="alert"></p>
          <div class="progresso" id="progresso" hidden><div></div></div>
          <p class="progresso-texto" id="progresso-texto" hidden></p>
          <button class="botao primario largo" type="submit" id="btn-enviar" disabled>Enviar guia</button>
        </div>
      </form>
    </section>`;
  }

  let arquivosEscolhidos = [];

  function ligarPainelAnexar(){
    const f = $('#form-anexar');
    const soltar = $('#soltar');
    const inputPdf = f.pdf;
    arquivosEscolhidos = [];

    const tipoAtual = () => f.tipo.value;
    function atualizarPassos(){
      const tipo = tipoAtual();
      $('#passo-dados').disabled = !tipo;
      const dadosOk = !!tipo && f.numero.value.trim() && f.data.value;
      $('#passo-pdf').disabled = !dadosOk;
      if (tipo === 'honorario'){
        inputPdf.multiple = true;
        $('#rotulo-pdf').textContent = 'PDFs do honorário';
        $('#dica-pdf').textContent = `Só PDF, no máximo ${MAX_ANEXOS}. Pode escolher vários de uma vez.`;
      } else {
        inputPdf.multiple = false;
        $('#rotulo-pdf').textContent = 'PDF da guia';
        $('#dica-pdf').textContent = 'Só PDF. Um arquivo só.';
        if (arquivosEscolhidos.length > 1) arquivosEscolhidos = arquivosEscolhidos.slice(0, 1);
      }
      renderizarArquivos();
      $('#btn-enviar').disabled = !(dadosOk && arquivosEscolhidos.length);
    }

    function receberArquivos(lista){
      const erro = $('#erro-anexar');
      erro.textContent = '';
      const novos = Array.from(lista || []);
      const problemas = [];
      for (const a of novos){
        const ehPdf = /\.pdf$/i.test(a.name) || a.type === 'application/pdf';
        if (!ehPdf){ problemas.push(`"${a.name}" não é PDF.`); continue; }
        if (a.size > LIMITE_PDF){ problemas.push(`"${a.name}" é grande demais (${tamanhoBR(a.size)}; o máximo é 100 MB).`); continue; }
        if (a.size === 0){ problemas.push(`"${a.name}" está vazio.`); continue; }
        if (arquivosEscolhidos.some(x => x.name === a.name && x.size === a.size)) continue;
        arquivosEscolhidos.push(a);
      }
      if (tipoAtual() !== 'honorario' && arquivosEscolhidos.length > 1){
        arquivosEscolhidos = [arquivosEscolhidos[arquivosEscolhidos.length - 1]];
        problemas.push('Guia de consulta leva um PDF só — fica o último escolhido.');
      }
      if (arquivosEscolhidos.length > MAX_ANEXOS){
        arquivosEscolhidos = arquivosEscolhidos.slice(0, MAX_ANEXOS);
        problemas.push(`No máximo ${MAX_ANEXOS} PDFs por guia de honorário.`);
      }
      if (problemas.length) erro.textContent = problemas.join(' ');
      inputPdf.value = '';
      atualizarPassos();
    }

    function renderizarArquivos(){
      $('#lista-arquivos').innerHTML = arquivosEscolhidos.map((a, i) => `
        <li><span class="pdf-ico">PDF</span><span class="nome" title="${h(a.name)}">${h(a.name)}</span><span class="tam">${tamanhoBR(a.size)}</span>
        <button type="button" data-tirar="${i}" aria-label="Tirar ${h(a.name)}">×</button></li>`).join('');
    }

    f.addEventListener('change', ev => {
      if (ev.target === inputPdf) receberArquivos(inputPdf.files);
      else atualizarPassos();
    });
    f.addEventListener('input', ev => { if (ev.target !== inputPdf) atualizarPassos(); });
    $('#lista-arquivos').addEventListener('click', ev => {
      const b = ev.target.closest('[data-tirar]');
      if (!b) return;
      arquivosEscolhidos.splice(Number(b.dataset.tirar), 1);
      atualizarPassos();
    });
    ['dragenter', 'dragover'].forEach(t => soltar.addEventListener(t, ev => { ev.preventDefault(); if (!$('#passo-pdf').disabled) soltar.classList.add('sobre'); }));
    ['dragleave', 'drop'].forEach(t => soltar.addEventListener(t, ev => { ev.preventDefault(); soltar.classList.remove('sobre'); }));
    soltar.addEventListener('drop', ev => { if (!$('#passo-pdf').disabled) receberArquivos(ev.dataTransfer.files); });

    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      await enviarGuia(f);
    });
  }

  // Envia um PDF para uma guia nova ({ nova:{tipo,numero,data} }) ou para
  // uma guia de honorário existente ({ guia:id, pasta }). Devolve
  // { guia_id, competencia }. Em produção o arquivo vai direto para o
  // armazenamento; no modo local passa pelo servidor.
  async function enviarArquivo(destino, arquivo, aoProgredir){
    if (!estado.direto){
      const q = destino.nova
        ? new URLSearchParams({ acao: 'nova-guia', ...destino.nova, nome: arquivo.name })
        : new URLSearchParams({ guia: destino.guia, nome: arquivo.name });
      return enviarPdfPeloServidor(`/api/arquivos?${q}`, arquivo, aoProgredir);
    }
    const pasta = destino.nova ? `${destino.nova.data.slice(0, 7)}/${destino.nova.tipo}-${destino.nova.numero}` : (destino.pasta || 'anexos');
    const caminho = `clinica-${estado.usuario.clinica_id}/${pasta}-${Date.now()}.pdf`.replace(/[^A-Za-z0-9/._-]/g, '_');
    let r;
    try {
      r = await VercelBlob.upload(caminho, arquivo, {
        access: 'private', handleUploadUrl: '/api/upload', contentType: 'application/pdf',
        multipart: arquivo.size > 20 * 1024 * 1024,
        onUploadProgress: p => aoProgredir((p.percentage || 0) / 100),
      });
    } catch (e){
      console.error('upload direto:', e);
      const msg = String(e && e.message || '');
      if (/401|session|sess/i.test(msg)){ estado.usuario = null; mostrarLogin('Sua sessão terminou. Entre de novo.'); }
      throw new Error('Não foi possível enviar o PDF. Confira a internet e tente de novo.');
    }
    const corpo = { chave: r.pathname, nome: arquivo.name, tamanho: arquivo.size, ...(destino.nova ? { nova: destino.nova } : { guia: destino.guia }) };
    return api('/api/arquivos?acao=registrar', { method: 'POST', body: JSON.stringify(corpo) });
  }

  // Conferência rápida antes de subir (envio direto): número repetido,
  // data errada, guia sem espaço — avisa antes de gastar o upload.
  async function conferirDestino(destino){
    if (!estado.direto) return;
    await api('/api/arquivos?acao=conferir', { method: 'POST', body: JSON.stringify(destino.nova ? { nova: destino.nova } : { guia: destino.guia }) });
  }

  function enviarPdfPeloServidor(url, arquivo, aoProgredir){
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      // octet-stream: na Vercel o corpo chega como Buffer em req.body
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = e => { if (e.lengthComputable) aoProgredir(e.loaded / e.total); };
      x.onload = () => {
        let dados = {};
        try { dados = JSON.parse(x.responseText); } catch {}
        if (x.status === 401){ estado.usuario = null; mostrarLogin('Sua sessão terminou. Entre de novo.'); reject(new Error('Sessão encerrada.')); return; }
        if (x.status >= 200 && x.status < 300) resolve(dados);
        else reject(new Error(dados.erro || (x.status === 413 ? 'O arquivo passa do tamanho permitido (4 MB).' : 'Não foi possível enviar. Tente de novo.')));
      };
      x.onerror = () => reject(new Error('Sem conexão com o servidor. Confira a internet e tente de novo.'));
      x.send(arquivo);
    });
  }

  async function enviarGuia(f){
    const erro = $('#erro-anexar');
    const botao = $('#btn-enviar');
    const barra = $('#progresso'), barraInterna = $('#progresso div'), texto = $('#progresso-texto');
    erro.textContent = '';
    const tipo = f.tipo.value, numero = f.numero.value.trim().replace(/\s+/g, ''), data = f.data.value;
    if (!/^[0-9A-Za-z./-]{1,30}$/.test(numero)){ erro.textContent = 'O número da guia só pode ter números, letras, ponto, barra e traço.'; f.numero.focus(); return; }
    if (data > hojeISO()){ erro.textContent = 'A data do atendimento não pode ser depois de hoje.'; f.data.focus(); return; }
    const arquivos = arquivosEscolhidos.slice();
    const total = arquivos.length;

    botao.disabled = true; botao.textContent = 'Enviando…';
    $$('fieldset', f).forEach(x => x.disabled = true);
    barra.hidden = false; texto.hidden = false;
    const progresso = (i, p) => { barraInterna.style.width = `${Math.round(((i + p) / total) * 100)}%`; texto.textContent = total > 1 ? `Enviando PDF ${i + 1} de ${total}…` : 'Enviando…'; };

    let guiaId = null, competencia = null, enviados = 0;
    try {
      const nova = { tipo, numero, data };
      await conferirDestino({ nova });
      progresso(0, 0);
      const r = await enviarArquivo({ nova }, arquivos[0], p => progresso(0, p));
      guiaId = r.guia_id; competencia = r.competencia; enviados = 1;
      for (let i = 1; i < total; i++){
        progresso(i, 0);
        await enviarArquivo({ guia: guiaId, pasta: `${competencia}/${tipo}-${numero}` }, arquivos[i], p => progresso(i, p));
        enviados++;
      }
      aviso(`Guia ${numero} enviada${total > 1 ? ` com ${total} PDFs` : ''} — ${mesNome(competencia)}.`);
      f.reset();
      arquivosEscolhidos = [];
      $('#lista-arquivos').innerHTML = '';
      estado.destacar = guiaId;
      estado.mes = competencia;
      await carregarMeses({ pulsar: competencia });
      f.numero.focus();
    } catch (e){
      if (guiaId && enviados < total){
        erro.textContent = `${e.message} A guia ${numero} ficou salva com ${enviados} de ${total} PDFs — anexe o restante pela lista (botão "+ PDF").`;
        estado.destacar = guiaId; estado.mes = competencia;
        await carregarMeses();
      } else {
        erro.textContent = e.message;
      }
    } finally {
      barra.hidden = true; texto.hidden = true; barraInterna.style.width = '0';
      botao.textContent = 'Enviar guia';
      $$('fieldset', f).forEach(x => x.disabled = false);
      // reaplica o estado dos passos
      f.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ---------------------------------------------------------------- Faturas: escolha da clínica
  async function renderizarBarraClinica(){
    const caixa = $('#barra-clinica');
    if (!caixa) return;
    try {
      if (!estado.admin) estado.admin = await api('/api/admin?acao=dados');
    } catch (e){ aviso(e.message, true); return; }
    const clinicas = estado.admin.clinicas;
    if (!estado.clinica && clinicas.length === 1) estado.clinica = String(clinicas[0].id);
    caixa.innerHTML = `
      <div class="barra-clinica">
        <div>
          <h2>Guias recebidas</h2>
          <p>O que a recepção anexou, mês a mês. Abrir ou baixar um PDF marca a guia como recebida.</p>
        </div>
        <label class="campo"><span>Clínica</span>
          <select id="sel-clinica">
            <option value="">Todas as clínicas</option>
            ${clinicas.map(c => `<option value="${c.id}" ${String(c.id) === estado.clinica ? 'selected' : ''}>${h(c.nome)}${c.ativa ? '' : ' (desativada)'}</option>`).join('')}
          </select>
        </label>
      </div>`;
    $('#sel-clinica').onchange = ev => { estado.clinica = ev.target.value; estado.selecionadas.clear(); estado.mes = null; carregarMeses(); };
  }

  // ---------------------------------------------------------------- arquivo por mês
  function urlGuias(extra){
    const q = new URLSearchParams(extra);
    if (estado.usuario.perfil === 'faturas' && estado.clinica) q.set('clinica', estado.clinica);
    return `/api/guias?${q}`;
  }

  async function carregarMeses(op = {}){
    const caixa = $('#arquivo');
    if (!caixa) return;
    if (!estado.meses.length) caixa.innerHTML = '<div class="carregando">Carregando…</div>';
    try {
      const r = await api(urlGuias({ acao: 'meses' }));
      estado.meses = r.meses;
      const atual = (r.hoje || hojeISO()).slice(0, 7);
      if (!estado.meses.some(m => m.competencia === atual)) estado.meses.unshift({ competencia: atual, total: 0, consultas: 0, honorarios: 0, novas: 0, vazio: true });
      estado.meses.sort((a, b) => b.competencia < a.competencia ? -1 : 1);
      if (!estado.mes || !estado.meses.some(m => m.competencia === estado.mes)) estado.mes = estado.meses[0].competencia;
      renderizarArquivo(op);
      await carregarGuias();
    } catch (e){
      caixa.innerHTML = `<div class="vazio"><strong>Não deu para carregar as guias</strong>${h(e.message)}</div>`;
    }
  }

  function renderizarArquivo(op = {}){
    const u = estado.usuario;
    const caixa = $('#arquivo');
    caixa.innerHTML = `
      ${u.perfil === 'recepcao' ? `<div class="arquivo-cabeca"><h2>Guias enviadas</h2></div>` : ''}
      <div class="abas-mes" role="tablist" aria-label="Meses">
        ${estado.meses.map(m => `
          <button type="button" role="tab" class="aba-mes" data-mes="${m.competencia}" aria-selected="${m.competencia === estado.mes}">
            <span class="mes">${MESES_CURTO[Number(m.competencia.slice(5, 7)) - 1]}<span class="qtd ${op.pulsar === m.competencia ? 'pulsa' : ''}">${m.total}</span></span>
            <span class="ano">${m.competencia.slice(0, 4)}</span>
            ${u.perfil === 'faturas' && m.novas ? `<span class="novas" title="${m.novas} ainda não abertas">${m.novas} novas</span>` : ''}
          </button>`).join('')}
      </div>
      <div class="pasta">
        <div class="pasta-barra">
          <div class="pasta-resumo" id="pasta-resumo"></div>
          <div class="pasta-filtros">
            <div class="segmento" role="group" aria-label="Tipo">
              <button type="button" data-tipo="todas" aria-pressed="${estado.filtroTipo === 'todas'}">Todas</button>
              <button type="button" data-tipo="consulta" aria-pressed="${estado.filtroTipo === 'consulta'}">Consultas</button>
              <button type="button" data-tipo="honorario" aria-pressed="${estado.filtroTipo === 'honorario'}">Honorários</button>
            </div>
            <input type="search" id="busca" placeholder="Buscar número" value="${h(estado.busca)}" aria-label="Buscar pelo número da guia">
            ${u.perfil === 'faturas' ? `<label class="marcar"><input type="checkbox" id="ver-excluidas" ${estado.verExcluidas ? 'checked' : ''}> mostrar excluídas</label>` : ''}
          </div>
        </div>
        ${u.perfil === 'faturas' ? `<div class="pasta-acoes" id="pasta-acoes"></div>` : ''}
        <div id="tabela"><div class="carregando">Carregando…</div></div>
      </div>`;

    $('.abas-mes', caixa).onclick = ev => {
      const b = ev.target.closest('[data-mes]');
      if (!b || b.dataset.mes === estado.mes) return;
      estado.mes = b.dataset.mes; estado.selecionadas.clear();
      $$('.aba-mes', caixa).forEach(x => x.setAttribute('aria-selected', String(x === b)));
      carregarGuias();
    };
    $('.segmento', caixa).onclick = ev => {
      const b = ev.target.closest('[data-tipo]');
      if (!b) return;
      estado.filtroTipo = b.dataset.tipo;
      $$('.segmento button', caixa).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      renderizarTabela();
    };
    $('#busca').oninput = ev => { estado.busca = ev.target.value; renderizarTabela(); };
    const ve = $('#ver-excluidas');
    if (ve) ve.onchange = () => { estado.verExcluidas = ve.checked; carregarGuias(); };
  }

  async function carregarGuias(){
    const mes = estado.mes;
    const alvo = $('#tabela');
    if (!alvo) return;
    try {
      const extra = { mes };
      if (estado.usuario.perfil === 'faturas' && estado.verExcluidas) extra.excluidas = '1';
      const r = await api(urlGuias(extra));
      if (estado.mes !== mes) return; // trocou de mês enquanto carregava
      estado.guias = r.guias;
      renderizarTabela();
    } catch (e){
      alvo.innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`;
    }
  }

  function guiasFiltradas(){
    const b = estado.busca.replace(/\s+/g, '').toUpperCase();
    return estado.guias.filter(g => (estado.filtroTipo === 'todas' || g.tipo === estado.filtroTipo) && (!b || g.numero.includes(b)));
  }

  function renderizarTabela(){
    const u = estado.usuario;
    const faturas = u.perfil === 'faturas';
    const lista = guiasFiltradas();
    const ativas = estado.guias.filter(g => !g.excluido_em);
    const resumo = $('#pasta-resumo');
    const consultas = ativas.filter(g => g.tipo === 'consulta').length, honorarios = ativas.length - consultas;
    resumo.innerHTML = `<strong>${h(mesNome(estado.mes))}</strong> · ${ativas.length} ${ativas.length === 1 ? 'guia' : 'guias'}${ativas.length ? ` — ${consultas} consulta${consultas === 1 ? '' : 's'}, ${honorarios} honorário${honorarios === 1 ? '' : 's'}` : ''}`;

    const alvo = $('#tabela');
    if (!lista.length){
      alvo.innerHTML = estado.guias.length
        ? `<div class="vazio"><strong>Nenhuma guia com esse filtro</strong>Mude o tipo ou limpe a busca.</div>`
        : faturas
          ? `<div class="vazio"><strong>Nada em ${h(mesNome(estado.mes))}</strong>A recepção ainda não anexou guias com atendimento neste mês.</div>`
          : `<div class="vazio"><strong>Nenhuma guia em ${h(mesNome(estado.mes))}</strong>Use o painel ao lado para anexar a primeira.</div>`;
      if (faturas) renderizarAcoes();
      return;
    }

    const mostrarClinica = faturas && !estado.clinica;
    alvo.innerHTML = `
      <table class="guias">
        <thead><tr>
          ${faturas ? `<th><input type="checkbox" id="marcar-todas" aria-label="Marcar todas"></th>` : ''}
          <th>Guia</th><th>Tipo</th><th>Atendimento</th>${mostrarClinica ? '<th>Clínica</th>' : ''}<th>PDF</th><th>Enviada</th><th>Situação</th><th></th>
        </tr></thead>
        <tbody>
        ${lista.map(g => {
          const excluida = !!g.excluido_em;
          const sit = excluida ? `<span class="situacao excluida">Excluída ${h(quandoBR(g.excluido_em))}${g.excluido_por_nome ? ' por ' + h(g.excluido_por_nome) : ''}</span>`
            : g.baixado_em ? `<span class="situacao baixada">${faturas ? 'Aberta' : 'Recebida pela Faturas Med'} ${h(quandoBR(g.baixado_em))}</span>`
            : `<span class="situacao nova">${faturas ? 'Nova' : 'Enviada'}</span>`;
          const pdfs = g.anexos.map((a, i) => `
            <span class="pdf-grupo">
              <a class="pdf" href="/api/arquivos?id=${a.id}" target="_blank" rel="noopener" title="${h(a.nome)} · ${tamanhoBR(a.tamanho)}" data-abrir="${g.id}">PDF${g.anexos.length > 1 ? ' ' + (i + 1) : ''}</a>
              ${!faturas && g.tipo === 'honorario' && g.anexos.length > 1 ? `<button type="button" class="tirar" data-tirar-anexo="${a.id}" title="Tirar este PDF" aria-label="Tirar PDF ${i + 1}">×</button>` : ''}
            </span>`).join('');
          const acoes = excluida ? '' : faturas
            ? `<a class="link" href="/api/arquivos?id=${g.anexos[0]?.id}&baixar=1" data-abrir="${g.id}">Baixar</a>`
            : `${g.tipo === 'honorario' && g.anexos.length < MAX_ANEXOS ? `<button type="button" class="link" data-mais="${g.id}">+ PDF</button>` : ''}<button type="button" class="link perigo" data-excluir="${g.id}">Excluir</button>`;
          return `<tr class="${excluida ? 'excluida' : ''} ${estado.destacar === g.id ? 'nova-linha' : ''}" data-id="${g.id}">
            ${faturas ? `<td>${excluida ? '' : `<input type="checkbox" data-marcar="${g.id}" ${estado.selecionadas.has(g.id) ? 'checked' : ''} aria-label="Marcar guia ${h(g.numero)}">`}</td>` : ''}
            <td class="c-num"><span class="num">${h(g.numero)}</span></td>
            <td class="c-tipo"><span class="chip ${g.tipo}">${tipoNome(g.tipo)}</span></td>
            <td class="c-dt dt" data-r="Atendimento:">${dataBR(g.data_atendimento)}</td>
            ${mostrarClinica ? `<td class="c-clin" data-r="Clínica:">${h(g.clinica_nome)}</td>` : ''}
            <td class="c-pdfs"><div class="pdfs">${pdfs || '<span class="quando">—</span>'}</div></td>
            <td class="c-quando quando" data-r="Enviada:">${h(quandoBR(g.criado_em))}${faturas && g.enviado_por_nome ? `<br>por ${h(g.enviado_por_nome)}` : ''}</td>
            <td class="c-sit">${sit}</td>
            <td class="acoes">${acoes}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>`;
    estado.destacar = null;

    alvo.onclick = async ev => {
      const t = ev.target;
      if (t.dataset.excluir) return excluirGuia(Number(t.dataset.excluir));
      if (t.dataset.tirarAnexo) return tirarAnexo(Number(t.dataset.tirarAnexo));
      if (t.dataset.mais) return maisPdf(Number(t.dataset.mais));
      if (t.dataset.abrir && faturas){
        const g = estado.guias.find(x => x.id === Number(t.dataset.abrir));
        if (g && !g.baixado_em){ g.baixado_em = new Date().toISOString(); setTimeout(() => { renderizarTabela(); atualizarContagemNovas(); }, 400); }
      }
      if (t.id === 'marcar-todas'){
        lista.filter(g => !g.excluido_em).forEach(g => t.checked ? estado.selecionadas.add(g.id) : estado.selecionadas.delete(g.id));
        $$('[data-marcar]', alvo).forEach(c => c.checked = t.checked);
        renderizarAcoes();
      } else if (t.dataset.marcar){
        t.checked ? estado.selecionadas.add(Number(t.dataset.marcar)) : estado.selecionadas.delete(Number(t.dataset.marcar));
        renderizarAcoes();
      }
    };
    if (faturas) renderizarAcoes();
  }

  function atualizarContagemNovas(){
    const m = estado.meses.find(x => x.competencia === estado.mes);
    if (!m) return;
    m.novas = estado.guias.filter(g => !g.excluido_em && !g.baixado_em).length;
    const aba = $(`.aba-mes[data-mes="${estado.mes}"]`);
    if (!aba) return;
    const el = $('.novas', aba);
    if (!m.novas){ if (el) el.remove(); }
    else if (el) el.textContent = `${m.novas} novas`;
  }

  async function excluirGuia(id){
    const g = estado.guias.find(x => x.id === id);
    if (!g) return;
    const ok = await confirmar({
      titulo: 'Excluir esta guia?',
      texto: `Guia <strong>${h(g.numero)}</strong> (${tipoNome(g.tipo).toLowerCase()}, atendimento ${dataBR(g.data_atendimento)})${g.anexos.length > 1 ? ` e os ${g.anexos.length} PDFs dela` : ' e o PDF dela'} saem da lista. Depois você pode enviar a guia certa.`,
      botao: 'Excluir guia', perigo: true,
    });
    if (!ok) return;
    try {
      await api(`/api/guias?id=${id}`, { method: 'DELETE' });
      aviso(`Guia ${g.numero} excluída.`);
      await carregarMeses();
    } catch (e){ aviso(e.message, true); }
  }

  async function tirarAnexo(anexoId){
    const g = estado.guias.find(x => x.anexos.some(a => a.id === anexoId));
    if (!g) return;
    const i = g.anexos.findIndex(a => a.id === anexoId);
    const ok = await confirmar({ titulo: 'Tirar este PDF?', texto: `O PDF ${i + 1} (${h(g.anexos[i].nome)}) sai da guia <strong>${h(g.numero)}</strong>. Os outros ficam.`, botao: 'Tirar PDF', perigo: true });
    if (!ok) return;
    try {
      await api(`/api/arquivos?id=${anexoId}`, { method: 'DELETE' });
      aviso('PDF retirado.');
      await carregarGuias();
    } catch (e){ aviso(e.message, true); }
  }

  function maisPdf(guiaId){
    const g = estado.guias.find(x => x.id === guiaId);
    if (!g) return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/pdf,.pdf'; input.multiple = true;
    input.onchange = async () => {
      const arquivos = Array.from(input.files).filter(a => /\.pdf$/i.test(a.name) || a.type === 'application/pdf');
      if (!arquivos.length) return aviso('Escolha arquivos PDF.', true);
      const grande = arquivos.find(a => a.size > LIMITE_PDF);
      if (grande) return aviso(`"${grande.name}" é grande demais (máximo 100 MB).`, true);
      if (g.anexos.length + arquivos.length > MAX_ANEXOS) return aviso(`A guia ficaria com mais de ${MAX_ANEXOS} PDFs.`, true);
      let n = 0;
      try {
        await conferirDestino({ guia: guiaId });
        for (const a of arquivos){
          await enviarArquivo({ guia: guiaId, pasta: `${g.competencia}/${g.tipo}-${g.numero}` }, a, () => {});
          n++;
        }
        aviso(`${n} PDF${n > 1 ? 's anexados' : ' anexado'} à guia ${g.numero}.`);
      } catch (e){ aviso(`${e.message}${n ? ` (${n} de ${arquivos.length} foram anexados)` : ''}`, true); }
      estado.destacar = guiaId;
      await carregarGuias();
    };
    input.click();
  }

  // ---------------------------------------------------------------- Faturas: baixar em lote (.zip)
  function renderizarAcoes(){
    const caixa = $('#pasta-acoes');
    if (!caixa) return;
    const ativas = guiasFiltradas().filter(g => !g.excluido_em);
    const n = estado.selecionadas.size;
    caixa.innerHTML = `
      <button type="button" class="botao secundario pequeno" id="baixar-sel" ${n ? '' : 'disabled'}>Baixar ${n ? n + ' selecionada' + (n > 1 ? 's' : '') : 'selecionadas'} (.zip)</button>
      <button type="button" class="botao secundario pequeno" id="baixar-mes" ${ativas.length ? '' : 'disabled'}>Baixar o mês inteiro (.zip)</button>
      <span class="status" id="status-zip"></span>`;
    $('#baixar-sel').onclick = () => baixarZip(ativas.filter(g => estado.selecionadas.has(g.id)));
    $('#baixar-mes').onclick = () => baixarZip(ativas);
  }

  async function baixarZip(guias){
    if (!guias.length) return;
    const status = $('#status-zip');
    const botoes = $$('#pasta-acoes button');
    botoes.forEach(b => b.disabled = true);
    const zip = new ZipSimples();
    const umaClinica = new Set(guias.map(g => g.clinica_id)).size === 1;
    let feitos = 0, total = guias.reduce((s, g) => s + g.anexos.length, 0);
    try {
      for (const g of guias){
        for (let i = 0; i < g.anexos.length; i++){
          status.textContent = `Preparando ${++feitos} de ${total} PDFs…`;
          const r = await fetch(`/api/arquivos?id=${g.anexos[i].id}`, { credentials: 'same-origin' });
          if (!r.ok) throw new Error(`Não deu para baixar o PDF da guia ${g.numero}.`);
          const pasta = umaClinica ? '' : g.clinica_nome.replace(/[\\/:*?"<>|]/g, '-') + '/';
          zip.adicionar(`${pasta}${g.tipo === 'consulta' ? 'CONSULTAS' : 'HONORARIOS'}/${nomePdf(g, i, g.anexos.length)}`, new Uint8Array(await r.arrayBuffer()));
          if (!g.baixado_em) g.baixado_em = new Date().toISOString();
        }
      }
      const clinicaNome = umaClinica ? guias[0].clinica_nome.replace(/[\\/:*?"<>|]/g, '-') + '_' : '';
      const nome = `${clinicaNome}${estado.mes.replace('-', '.')}_${guias.length}guias.zip`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip.gerar()); a.download = nome; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      status.textContent = `Pronto: ${nome}`;
      estado.selecionadas.clear();
      renderizarTabela(); atualizarContagemNovas();
    } catch (e){
      status.textContent = '';
      aviso(e.message, true);
      botoes.forEach(b => b.disabled = false);
    }
  }

  // ---------------------------------------------------------------- Faturas: clínicas e acessos
  async function carregarAcessos(){
    try { estado.admin = await api('/api/admin?acao=dados'); }
    catch (e){ $('#acessos').innerHTML = `<div class="vazio"><strong>Não deu para carregar</strong>${h(e.message)}</div>`; return; }
    renderizarAcessos();
  }

  function gerarSenha(){
    const letras = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, b => letras[b % letras.length]).join('');
  }

  function renderizarAcessos(){
    const { clinicas, usuarios, eu } = estado.admin;
    const ativasC = clinicas.filter(c => c.ativa);
    $('#acessos').innerHTML = `
      <section class="painel">
        <h2>Clínicas</h2>
        <p class="sub">Cada clínica tem seus próprios usuários de recepção e só enxerga as próprias guias.</p>
        <ul class="lista-simples">
          ${clinicas.length ? clinicas.map(c => `
            <li class="${c.ativa ? '' : 'inativo'}">
              <div class="info"><strong>${h(c.nome)}</strong><small>${c.usuarios} acesso${c.usuarios === 1 ? '' : 's'} · ${c.guias} guia${c.guias === 1 ? '' : 's'}${c.ativa ? '' : ' · desativada'}</small></div>
              <button type="button" class="link" data-renomear="${c.id}">Renomear</button>
              <button type="button" class="link ${c.ativa ? 'perigo' : ''}" data-clinica-ativa="${c.id}" data-valor="${!c.ativa}">${c.ativa ? 'Desativar' : 'Reativar'}</button>
            </li>`).join('') : '<li><div class="info"><small>Nenhuma clínica cadastrada ainda.</small></div></li>'}
        </ul>
        <form id="form-clinica" class="form-linha">
          <label class="campo"><span>Nova clínica</span><input name="nome" maxlength="120" placeholder="Nome da clínica" required></label>
          <button class="botao primario" type="submit">Cadastrar</button>
        </form>
        <p class="erro" id="erro-clinica" role="alert"></p>
      </section>

      <section class="painel">
        <h2>Acessos</h2>
        <p class="sub">Quem entra no sistema. A senha pode ser redefinida a qualquer momento.</p>
        <ul class="lista-simples">
          ${usuarios.map(x => `
            <li class="${x.ativo ? '' : 'inativo'}">
              <div class="info">
                <strong>${h(x.nome)} <span class="mono" style="font-weight:500;color:var(--cinza);font-size:13px">${h(x.login)}</span></strong>
                <small><span class="selo ${x.perfil}">${x.perfil === 'faturas' ? 'Faturas Med' : 'Recepção'}</span> ${x.clinica_nome ? h(x.clinica_nome) : ''}${x.ativo ? '' : ' <span class="selo off">desativado</span>'}${x.id === eu ? ' · você' : ''}</small>
              </div>
              <button type="button" class="link" data-redefinir="${x.id}">Redefinir senha</button>
              ${x.id === eu ? '' : `<button type="button" class="link ${x.ativo ? 'perigo' : ''}" data-usuario-ativo="${x.id}" data-valor="${!x.ativo}">${x.ativo ? 'Desativar' : 'Reativar'}</button>`}
            </li>`).join('')}
        </ul>
        <hr class="separador">
        <h3 class="titulo-form">Novo acesso</h3>
        <form id="form-usuario" class="form-grade" autocomplete="off">
          <label class="campo"><span>Nome da pessoa</span><input name="nome" maxlength="120" required></label>
          <label class="campo"><span>Usuário (para entrar)</span><input name="login" maxlength="40" autocapitalize="none" required><small>Sem espaço nem acento. Ex.: recepcao.saojose</small></label>
          <label class="campo"><span>Perfil</span>
            <select name="perfil"><option value="recepcao">Recepção da clínica</option><option value="faturas">Equipe Faturas Med</option></select>
          </label>
          <label class="campo"><span>Clínica</span>
            <select name="clinica_id" ${ativasC.length ? '' : 'disabled'}>${ativasC.map(c => `<option value="${c.id}">${h(c.nome)}</option>`).join('') || '<option value="">Cadastre uma clínica primeiro</option>'}</select>
          </label>
          <label class="campo inteiro"><span>Senha inicial</span>
            <div class="senha-linha"><input name="senha" minlength="6" maxlength="60" value="${gerarSenha()}" required><button type="button" class="botao fantasma" id="gerar-senha">Gerar outra</button></div>
            <small>Anote e passe para a pessoa; ela pode trocar depois em "Trocar senha".</small>
          </label>
          <p class="erro inteiro" id="erro-usuario" role="alert"></p>
          <div class="inteiro"><button class="botao primario" type="submit">Criar acesso</button></div>
        </form>
      </section>`;

    const caixa = $('#acessos');
    $('#form-clinica').onsubmit = async ev => {
      ev.preventDefault();
      try {
        await api('/api/admin?acao=clinica', { method: 'POST', body: JSON.stringify({ nome: ev.target.nome.value }) });
        aviso('Clínica cadastrada.'); estado.clinica = ''; carregarAcessos();
      } catch (e){ $('#erro-clinica').textContent = e.message; }
    };
    const fu = $('#form-usuario');
    const ajustarClinica = () => { fu.clinica_id.closest('.campo').style.visibility = fu.perfil.value === 'recepcao' ? '' : 'hidden'; };
    fu.perfil.onchange = ajustarClinica; ajustarClinica();
    $('#gerar-senha').onclick = () => { fu.senha.value = gerarSenha(); };
    fu.nome.oninput = () => {
      if (fu.login.dataset.mexido) return;
      fu.login.value = fu.nome.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim().split(/\s+/).slice(0, 2).join('.').replace(/[^a-z0-9._-]/g, '');
    };
    fu.login.oninput = () => { fu.login.dataset.mexido = '1'; };
    fu.onsubmit = async ev => {
      ev.preventDefault();
      const dados = { nome: fu.nome.value, login: fu.login.value, perfil: fu.perfil.value, clinica_id: fu.clinica_id.value, senha: fu.senha.value };
      try {
        const r = await api('/api/admin?acao=usuario', { method: 'POST', body: JSON.stringify(dados) });
        mostrarCredenciais(dados.nome, r.login, dados.senha, dados.perfil);
        carregarAcessos();
      } catch (e){ $('#erro-usuario').textContent = e.message; }
    };

    caixa.onclick = async ev => {
      const t = ev.target.closest('button[data-renomear],button[data-clinica-ativa],button[data-redefinir],button[data-usuario-ativo]');
      if (!t) return;
      try {
        if (t.dataset.renomear){
          const c = estado.admin.clinicas.find(x => x.id === Number(t.dataset.renomear));
          const nome = await pedirTexto('Renomear clínica', 'Novo nome', c.nome);
          if (nome === null || nome === c.nome) return;
          await api('/api/admin?acao=clinica-editar', { method: 'POST', body: JSON.stringify({ id: c.id, nome }) });
          aviso('Clínica renomeada.');
        } else if (t.dataset.clinicaAtiva){
          const c = estado.admin.clinicas.find(x => x.id === Number(t.dataset.clinicaAtiva));
          const ativar = t.dataset.valor === 'true';
          if (!ativar && !(await confirmar({ titulo: `Desativar ${c.nome}?`, texto: 'A recepção dela deixa de entrar na hora. As guias já enviadas continuam aqui para a equipe.', botao: 'Desativar', perigo: true }))) return;
          await api('/api/admin?acao=clinica-editar', { method: 'POST', body: JSON.stringify({ id: c.id, ativa: ativar }) });
          aviso(ativar ? 'Clínica reativada.' : 'Clínica desativada.');
        } else if (t.dataset.redefinir){
          const x = estado.admin.usuarios.find(y => y.id === Number(t.dataset.redefinir));
          const senha = await pedirTexto(`Nova senha para ${x.nome}`, 'Nova senha (mín. 6)', gerarSenha());
          if (senha === null) return;
          await api('/api/admin?acao=usuario-editar', { method: 'POST', body: JSON.stringify({ id: x.id, senha }) });
          mostrarCredenciais(x.nome, x.login, senha, x.perfil);
        } else if (t.dataset.usuarioAtivo){
          const x = estado.admin.usuarios.find(y => y.id === Number(t.dataset.usuarioAtivo));
          const ativar = t.dataset.valor === 'true';
          if (!ativar && !(await confirmar({ titulo: `Desativar o acesso de ${x.nome}?`, texto: 'A pessoa é desconectada na hora e não entra mais até ser reativada.', botao: 'Desativar', perigo: true }))) return;
          await api('/api/admin?acao=usuario-editar', { method: 'POST', body: JSON.stringify({ id: x.id, ativo: ativar }) });
          aviso(ativar ? 'Acesso reativado.' : 'Acesso desativado.');
        }
        carregarAcessos();
      } catch (e){ aviso(e.message, true); }
    };
  }

  function pedirTexto(titulo, rotulo, valor){
    return new Promise(resolve => {
      const dlg = $('#dialogo');
      dlg.innerHTML = `
        <form id="form-texto">
          <h2>${h(titulo)}</h2>
          <label class="campo"><span>${h(rotulo)}</span><input name="v" value="${h(valor)}" required autocomplete="off"></label>
          <div class="rodape-dialogo">
            <button type="button" class="botao fantasma" data-fechar>Cancelar</button>
            <button type="submit" class="botao primario">Salvar</button>
          </div>
        </form>`;
      let resultado = null;
      $('[data-fechar]', dlg).onclick = () => dlg.close();
      $('#form-texto').onsubmit = ev => { ev.preventDefault(); resultado = ev.target.v.value.trim(); dlg.close(); };
      dlg.onclose = () => resolve(resultado);
      dlg.showModal();
      $('input', dlg).select();
    });
  }

  function mostrarCredenciais(nome, login, senha, perfil){
    const dlg = $('#dialogo');
    const texto = `Controle de Faturamento — Faturas Med\n${location.origin}\nEntrar como: ${perfil === 'faturas' ? 'FaturasMed' : 'Prestador'}\nUsuário: ${login}\nSenha: ${senha}`;
    dlg.innerHTML = `
      <form method="dialog">
        <h2>Acesso de ${h(nome)}</h2>
        <p>Passe estes dados para a pessoa. A senha não aparece de novo depois de fechar.</p>
        <div class="credenciais">${h(texto).replace(/\n/g, '<br>')}</div>
        <div class="rodape-dialogo">
          <button type="button" class="botao secundario" id="copiar-cred">Copiar</button>
          <button type="submit" class="botao primario">Fechar</button>
        </div>
      </form>`;
    dlg.onclose = null;
    $('#copiar-cred').onclick = async () => {
      try { await navigator.clipboard.writeText(texto); aviso('Copiado.'); } catch { aviso('Não deu para copiar — anote os dados.', true); }
    };
    dlg.showModal();
  }

  // ---------------------------------------------------------------- começo
  abertura();
})();
