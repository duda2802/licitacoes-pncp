/* Armazenamento dos documentos anexados.
 *  - Com login (Supabase): bucket privado "documentos", acessível só a quem tem acesso ao sistema.
 *  - Sem login: IndexedDB do navegador (os arquivos ficam só neste computador). */
(() => {
  'use strict';

  const BUCKET = 'documentos';
  const IDB_NOME = 'licitacoes-arquivos';
  const IDB_STORE = 'arquivos';

  const remoto = () => !!(window.Auth && window.Auth.usuario());

  // ---------- IndexedDB ----------
  let idbPromise = null;
  function idb() {
    if (!idbPromise) {
      idbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NOME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Armazenamento do navegador indisponível'));
      });
    }
    return idbPromise;
  }
  async function idbOp(modo, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, modo);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error || new Error('Falha ao acessar o armazenamento do navegador'));
      tx.onabort = () => reject(tx.error || new Error('Espaço insuficiente no navegador'));
    });
  }

  // Nome seguro para o caminho no Storage (sem acentos/espaços)
  const nomeSeguro = (n) => n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_').slice(-120) || 'arquivo';

  window.Arquivos = {
    onde: () => (remoto() ? 'nuvem' : 'local'),

    /** Guarda o arquivo e devolve os campos a gravar no anexo ({onde, path?}). */
    async salvar(anexo, file) {
      if (remoto()) {
        const { sb } = window.Auth;
        const path = `empresa/${anexo.id}/${nomeSeguro(file.name)}`; // base única da empresa
        const { error } = await sb.storage.from(BUCKET).upload(path, file, {
          contentType: file.type || 'application/octet-stream', upsert: false,
        });
        if (error) throw new Error(error.message || 'falha no envio');
        return { onde: 'nuvem', path };
      }
      await idbOp('readwrite', (s) => s.put(file, anexo.id));
      return { onde: 'local' };
    },

    /** Devolve o conteúdo (Blob) do anexo. */
    async abrir(anexo) {
      if (anexo.onde === 'nuvem') {
        if (!remoto()) throw new Error('entre na sua conta para abrir este documento');
        const { data, error } = await window.Auth.sb.storage.from(BUCKET).download(anexo.path);
        if (error) throw new Error(error.message || 'arquivo não encontrado');
        return data;
      }
      const blob = await idbOp('readonly', (s) => s.get(anexo.id));
      if (!blob) throw new Error('o arquivo foi guardado em outro navegador/computador');
      return blob;
    },

    async excluir(anexo) {
      if (anexo.onde === 'nuvem') {
        if (!remoto()) return;
        await window.Auth.sb.storage.from(BUCKET).remove([anexo.path]);
        return;
      }
      await idbOp('readwrite', (s) => s.delete(anexo.id));
    },
  };
})();
