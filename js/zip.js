// Monta um .zip no navegador, sem compressão (PDF já vem comprimido).
// Uso: const z = new ZipSimples(); z.adicionar('pasta/a.pdf', uint8array); const blob = z.gerar();
(function(){
  'use strict';

  const TABELA = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    TABELA[n] = c >>> 0;
  }
  function crc32(bytes){
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = TABELA[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dataDos(d){
    return {
      hora: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      dia: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  class ZipSimples {
    constructor(){ this.itens = []; }

    adicionar(nome, bytes){
      this.itens.push({ nome: new TextEncoder().encode(nome), bytes, crc: crc32(bytes) });
    }

    gerar(){
      const { hora, dia } = dataDos(new Date());
      const partes = [];
      const central = [];
      let posicao = 0;

      for (const item of this.itens){
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);      // nomes em UTF-8
        local.setUint16(8, 0, true);           // sem compressão
        local.setUint16(10, hora, true);
        local.setUint16(12, dia, true);
        local.setUint32(14, item.crc, true);
        local.setUint32(18, item.bytes.length, true);
        local.setUint32(22, item.bytes.length, true);
        local.setUint16(26, item.nome.length, true);
        local.setUint16(28, 0, true);
        partes.push(local, item.nome, item.bytes);

        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true);
        cd.setUint16(4, 20, true);
        cd.setUint16(6, 20, true);
        cd.setUint16(8, 0x0800, true);
        cd.setUint16(10, 0, true);
        cd.setUint16(12, hora, true);
        cd.setUint16(14, dia, true);
        cd.setUint32(16, item.crc, true);
        cd.setUint32(20, item.bytes.length, true);
        cd.setUint32(24, item.bytes.length, true);
        cd.setUint16(28, item.nome.length, true);
        cd.setUint16(30, 0, true);
        cd.setUint16(32, 0, true);
        cd.setUint16(34, 0, true);
        cd.setUint16(36, 0, true);
        cd.setUint32(38, 0, true);
        cd.setUint32(42, posicao, true);
        central.push(cd, item.nome);

        posicao += 30 + item.nome.length + item.bytes.length;
      }

      const tamanhoCentral = central.reduce((s, p) => s + p.byteLength, 0);
      const fim = new DataView(new ArrayBuffer(22));
      fim.setUint32(0, 0x06054b50, true);
      fim.setUint16(8, this.itens.length, true);
      fim.setUint16(10, this.itens.length, true);
      fim.setUint32(12, tamanhoCentral, true);
      fim.setUint32(16, posicao, true);

      return new Blob([...partes, ...central, fim], { type: 'application/zip' });
    }
  }

  window.ZipSimples = ZipSimples;
})();
