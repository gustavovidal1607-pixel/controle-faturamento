// Autoriza o envio DIRETO do navegador para o Vercel Blob (sem passar o
// PDF pela função, que só aceita 4,5 MB). O navegador chama aqui para
// receber um token de envio; depois registra a guia em
// /api/arquivos?acao=registrar. O próprio Blob também chama esta rota
// quando o envio termina (evento assinado) — só confirmamos.

const { handleUpload } = require('@vercel/blob/client');
const L = require('./_lib');

module.exports = L.rota(async (req, res) => {
  if (req.method !== 'POST') return L.responder(res, 405, { erro: 'Método não permitido.' });
  if (!L.uploadDireto()) return L.responder(res, 400, { erro: 'O envio direto não está ativo neste ambiente.' });
  const body = await L.lerJson(req);

  let u = null;
  if (body.type === 'blob.generate-client-token'){
    u = await L.exigirUsuario(req, res, 'recepcao');
    if (!u) return;
  }

  const resultado = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async (pathname) => {
      const prefixo = `clinica-${u.clinica_id}/`;
      if (!pathname.startsWith(prefixo) || !/\.pdf$/i.test(pathname) || pathname.includes('..')){
        throw new Error('Caminho de envio inválido.');
      }
      return {
        allowedContentTypes: ['application/pdf'],
        maximumSizeInBytes: L.LIMITE_PDF_DIRETO,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ usuario: u.id, clinica: u.clinica_id }),
      };
    },
    onUploadCompleted: async () => { /* o registro da guia é feito pelo navegador em acao=registrar */ },
  });
  return L.responder(res, 200, resultado);
});
