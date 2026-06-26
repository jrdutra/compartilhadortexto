const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: true
  }
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const PORT = process.env.PORT || 3000;

// ── Constantes de tempo ──────────────────────────────────────────────────────
const GRACE_PERIOD_MS      = 5  * 60 * 1000;  // 5 min  — canal sem usuários
const DEBOUNCE_HIST_MS     = 10 * 1000;        // 10 s   — debounce histórico
const MAX_HISTORICO        = 100;
const TEMPO_SEM_TEXTO_MS   = 10 * 1000;        // 10 s   — canal sem texto → excluir
const TEMPO_GRUPO_VAZIO_MS = 30 * 1000;        // 30 s   — grupo sem canais → excluir

// Rate limits
const LIMITE_SOCKET_CANAIS = 20;
const JANELA_SOCKET_MS     = 5  * 60 * 1000;
const LIMITE_GRUPO_CANAIS  = 100;
const JANELA_GRUPO_MS      = 10 * 60 * 1000;

// ── Estruturas de dados ──────────────────────────────────────────────────────
const textos       = {};  // textos[grupo][canal] = string
const clientes     = {};  // clientes[grupo][canal] = Set<socketId>
const timers       = {};  // timers[grupo][canal] = timeoutId (grace period)
const historico    = {};  // historico[grupo][canal] = [ISO, ...]
const debounceHist = {};  // debounceHist[grupo][canal] = timeoutId
const donos        = {};  // donos[grupo] = socketId (admin)
const ocultados    = {};  // ocultados[grupo][canal] = true|false

// Novos timers de inatividade
const timerSemTexto   = {};  // timerSemTexto[grupo][canal] = timeoutId
const timerGrupoVazio = {};  // timerGrupoVazio[grupo] = timeoutId

// Rate limiting
const banidos           = new Set();
const criacoesPorSocket = {};
const criacoesPorGrupo  = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

function chaveRoom(grupo, canal) { return `${grupo}::${canal}`; }
function getConectados(grupo, canal) { return clientes[grupo]?.[canal]?.size ?? 0; }

function getCanaisDoGrupo(grupo) {
  const comClientes = Object.keys(clientes[grupo] ?? {}).filter(c => getConectados(grupo, c) > 0);
  const comTimer    = Object.keys(timers[grupo] ?? {});
  return [...new Set([...comClientes, ...comTimer])].sort();
}

function todosSocketsDoGrupo(grupo, exceto = null) {
  const ids = [];
  for (const canal of Object.keys(clientes[grupo] ?? {})) {
    for (const sid of (clientes[grupo][canal] ?? [])) {
      if (sid !== exceto) ids.push(sid);
    }
  }
  return ids;
}

function isCanalOculto(grupo, canal) {
  return !!(ocultados[grupo]?.[canal]);
}

// ── Admin ────────────────────────────────────────────────────────────────────

function atribuirAdmin(grupo, socketId) {
  donos[grupo] = socketId;
  io.to(socketId).emit('adminStatus', { isAdmin: true, grupo });
  console.log(`Admin do grupo "${grupo}": ${socketId}`);
}

function transferirAdmin(grupo, socketIdSaindo) {
  if (donos[grupo] !== socketIdSaindo) return;
  const candidatos = todosSocketsDoGrupo(grupo, socketIdSaindo);
  if (candidatos.length > 0) {
    atribuirAdmin(grupo, candidatos[0]);
  } else {
    delete donos[grupo];
  }
}

// ── Timers de inatividade ────────────────────────────────────────────────────

function cancelarTimerSemTexto(grupo, canal) {
  if (timerSemTexto[grupo]?.[canal]) {
    clearTimeout(timerSemTexto[grupo][canal]);
    delete timerSemTexto[grupo][canal];
    if (!Object.keys(timerSemTexto[grupo]).length) delete timerSemTexto[grupo];
  }
}

function cancelarTimerGrupoVazio(grupo) {
  if (timerGrupoVazio[grupo]) {
    clearTimeout(timerGrupoVazio[grupo]);
    delete timerGrupoVazio[grupo];
  }
}

// Canal criado sem texto por TEMPO_SEM_TEXTO_MS → excluir automaticamente
function agendarVerificacaoTexto(grupo, canal) {
  cancelarTimerSemTexto(grupo, canal);
  if (!timerSemTexto[grupo]) timerSemTexto[grupo] = {};
  timerSemTexto[grupo][canal] = setTimeout(() => {
    cancelarTimerSemTexto(grupo, canal);

    const textoAtual = textos[grupo]?.[canal];
    if (textoAtual === undefined || !textoAtual.trim()) {
      const canaisRestantes = getCanaisDoGrupo(grupo).filter(x => x !== canal);
      io.to(chaveRoom(grupo, canal)).emit('canalExcluido', { grupo, canal, canaisRestantes });
      limparCanal(grupo, canal);
      cancelarTimer(grupo, canal);
      emitirDiretorio();
      agendarVerificacaoGrupoVazio(grupo);
      console.log(`Canal "${grupo}/${canal}" auto-excluído (sem texto em ${TEMPO_SEM_TEXTO_MS / 1000}s).`);
    }
  }, TEMPO_SEM_TEXTO_MS);
}

// Grupo sem canais por TEMPO_GRUPO_VAZIO_MS → excluir automaticamente
function agendarVerificacaoGrupoVazio(grupo) {
  // Se ainda há canais ativos, cancelar qualquer timer pendente e sair
  if (getCanaisDoGrupo(grupo).length > 0) {
    cancelarTimerGrupoVazio(grupo);
    return;
  }

  cancelarTimerGrupoVazio(grupo);
  timerGrupoVazio[grupo] = setTimeout(() => {
    delete timerGrupoVazio[grupo];

    if (getCanaisDoGrupo(grupo).length > 0) return; // ganhou canais nesse intervalo

    console.log(`Grupo "${grupo}" auto-excluído por inatividade (sem canais por ${TEMPO_GRUPO_VAZIO_MS / 1000}s).`);

    // Notificar TODOS os clientes conectados
    io.emit('grupoExcluido', { grupo });

    // Limpar todos os dados do grupo
    for (const c of Object.keys(clientes[grupo] ?? {})) limparCanal(grupo, c);
    for (const c of Object.keys(timers[grupo] ?? {})) cancelarTimer(grupo, c);
    delete clientes[grupo];
    delete textos[grupo];
    delete historico[grupo];
    delete timers[grupo];
    delete donos[grupo];
    delete ocultados[grupo];
    if (debounceHist[grupo]) {
      for (const c of Object.keys(debounceHist[grupo])) clearTimeout(debounceHist[grupo][c]);
      delete debounceHist[grupo];
    }
    if (timerSemTexto[grupo]) {
      for (const c of Object.keys(timerSemTexto[grupo])) clearTimeout(timerSemTexto[grupo][c]);
      delete timerSemTexto[grupo];
    }

    emitirDiretorio();
  }, TEMPO_GRUPO_VAZIO_MS);
}

// ── Grace period (canal sem usuários) ────────────────────────────────────────

function cancelarTimer(grupo, canal) {
  if (timers[grupo]?.[canal]) {
    clearTimeout(timers[grupo][canal]);
    delete timers[grupo][canal];
    if (!Object.keys(timers[grupo]).length) delete timers[grupo];
  }
}

function limparCanal(grupo, canal) {
  cancelarTimerSemTexto(grupo, canal);
  if (debounceHist[grupo]?.[canal]) {
    clearTimeout(debounceHist[grupo][canal]);
    delete debounceHist[grupo][canal];
    if (!Object.keys(debounceHist[grupo]).length) delete debounceHist[grupo];
  }
  for (const obj of [clientes, textos, historico, timers]) {
    if (obj[grupo]) {
      delete obj[grupo][canal];
      if (!Object.keys(obj[grupo]).length) delete obj[grupo];
    }
  }
  if (ocultados[grupo]) {
    delete ocultados[grupo][canal];
    if (!Object.keys(ocultados[grupo]).length) delete ocultados[grupo];
  }
}

function agendarLimpeza(grupo, canal) {
  cancelarTimer(grupo, canal);
  if (!timers[grupo]) timers[grupo] = {};
  timers[grupo][canal] = setTimeout(() => {
    if (getConectados(grupo, canal) === 0) {
      limparCanal(grupo, canal);
      emitirDiretorio();
      agendarVerificacaoGrupoVazio(grupo);
      console.log(`Canal "${grupo}/${canal}" expirou após grace period.`);
    }
  }, GRACE_PERIOD_MS);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

function registrarCriacaoCanal(socketId, grupo, canal) {
  const agora = Date.now();
  const isAdminDoGrupo = donos[grupo] === socketId;

  if (!isAdminDoGrupo) {
    if (!criacoesPorSocket[socketId]) criacoesPorSocket[socketId] = [];
    criacoesPorSocket[socketId] = criacoesPorSocket[socketId].filter(t => agora - t < JANELA_SOCKET_MS);
    criacoesPorSocket[socketId].push(agora);

    if (criacoesPorSocket[socketId].length > LIMITE_SOCKET_CANAIS) {
      banidos.add(socketId);
      delete criacoesPorSocket[socketId];
      const sock = io.sockets.sockets.get(socketId);
      if (sock) {
        sock.emit('banido', { motivo: 'Criação excessiva de canais. Sessão encerrada.' });
        sock.disconnect(true);
      }
      console.log(`Socket ${socketId} banido por criar mais de ${LIMITE_SOCKET_CANAIS} canais em 5 min.`);
      return 'banido';
    }
  }

  if (!criacoesPorGrupo[grupo]) criacoesPorGrupo[grupo] = [];
  criacoesPorGrupo[grupo] = criacoesPorGrupo[grupo].filter(e => agora - e.timestamp < JANELA_GRUPO_MS);
  criacoesPorGrupo[grupo].push({ canal, timestamp: agora });

  if (criacoesPorGrupo[grupo].length > LIMITE_GRUPO_CANAIS) {
    const canaisParaApagar = [...new Set(criacoesPorGrupo[grupo].map(e => e.canal))];
    criacoesPorGrupo[grupo] = [];
    console.log(`Grupo "${grupo}": spam detectado. Apagando ${canaisParaApagar.length} canais.`);

    for (const cApagar of canaisParaApagar) {
      const restantes = getCanaisDoGrupo(grupo).filter(x => x !== cApagar && !canaisParaApagar.includes(x));
      io.to(chaveRoom(grupo, cApagar)).emit('canalExcluido', { grupo, canal: cApagar, canaisRestantes: restantes });
      limparCanal(grupo, cApagar);
      cancelarTimer(grupo, cApagar);
    }
    emitirDiretorio();
    agendarVerificacaoGrupoVazio(grupo);
    return 'spam_grupo';
  }

  return 'ok';
}

// ── Histórico ─────────────────────────────────────────────────────────────────

function registrarHistorico(grupo, canal) {
  if (!historico[grupo]) historico[grupo] = {};
  if (!historico[grupo][canal]) historico[grupo][canal] = [];
  historico[grupo][canal].unshift(new Date().toISOString());
  if (historico[grupo][canal].length > MAX_HISTORICO) historico[grupo][canal].length = MAX_HISTORICO;
  io.to(chaveRoom(grupo, canal)).emit('historicoAtualizado', historico[grupo][canal]);
}

function agendarHistorico(grupo, canal) {
  if (!debounceHist[grupo]) debounceHist[grupo] = {};
  if (debounceHist[grupo][canal]) clearTimeout(debounceHist[grupo][canal]);
  debounceHist[grupo][canal] = setTimeout(() => {
    delete debounceHist[grupo][canal];
    if (!Object.keys(debounceHist[grupo]).length) delete debounceHist[grupo];
    registrarHistorico(grupo, canal);
  }, DEBOUNCE_HIST_MS);
}

// ── Diretório personalizado por socket ───────────────────────────────────────

function emitirInfoCanal(grupo, canal) {
  io.to(chaveRoom(grupo, canal)).emit('canalInfo', { conectados: getConectados(grupo, canal) });
}

function buildDiretorioParaSocket(socketId) {
  const dir = {};
  const grupos = new Set([...Object.keys(clientes), ...Object.keys(timers)]);
  for (const grupo of grupos) {
    const isAdminDoGrupo = donos[grupo] === socketId;
    const canais = getCanaisDoGrupo(grupo)
      .filter(c => isAdminDoGrupo || !isCanalOculto(grupo, c));
    if (canais.length) dir[grupo] = canais;
  }
  return dir;
}

function emitirDiretorio() {
  for (const [socketId, sock] of io.sockets.sockets) {
    sock.emit('diretorioAtualizado', buildDiretorioParaSocket(socketId));
  }
}

// ── Socket ───────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Conectou:', socket.id);

  let grupoAtual = null;
  let canalAtual = null;

  socket.emit('diretorioAtualizado', buildDiretorioParaSocket(socket.id));

  // ── joinCanal ────────────────────────────────────────────────────────────
  socket.on('joinCanal', ({ grupo, canal }) => {
    if (typeof grupo !== 'string' || typeof canal !== 'string') return;
    const g = grupo.trim(), c = canal.trim();
    if (!g || !c) return;

    if (banidos.has(socket.id)) {
      socket.emit('banido', { motivo: 'Sessão bloqueada por criação excessiva de canais.' });
      return;
    }

    const canalNovo = !getCanaisDoGrupo(g).includes(c);

    if (grupoAtual && canalAtual) {
      socket.leave(chaveRoom(grupoAtual, canalAtual));
      if (clientes[grupoAtual]?.[canalAtual]) {
        clientes[grupoAtual][canalAtual].delete(socket.id);
        emitirInfoCanal(grupoAtual, canalAtual);
        if (getConectados(grupoAtual, canalAtual) === 0) agendarLimpeza(grupoAtual, canalAtual);
      }
      if (grupoAtual !== g && donos[grupoAtual] === socket.id) {
        transferirAdmin(grupoAtual, socket.id);
        socket.emit('adminStatus', { isAdmin: false, grupo: grupoAtual });
      }
      emitirDiretorio();
    }

    // Cancelar timer de grupo vazio (atividade detectada no grupo)
    cancelarTimerGrupoVazio(g);

    if (canalNovo) {
      const resultado = registrarCriacaoCanal(socket.id, g, c);
      if (resultado === 'banido' || resultado === 'spam_grupo') return;
      // Canal novo: iniciar timer — deve receber texto em TEMPO_SEM_TEXTO_MS ou é excluído
      agendarVerificacaoTexto(g, c);
    }

    grupoAtual = g;
    canalAtual = c;
    socket.join(chaveRoom(g, c));

    if (!clientes[g]) clientes[g] = {};
    if (!clientes[g][c]) clientes[g][c] = new Set();
    clientes[g][c].add(socket.id);
    cancelarTimer(g, c);

    socket.emit('update', textos[g]?.[c] ?? '');
    socket.emit('historicoAtualizado', historico[g]?.[c] ?? []);
    emitirInfoCanal(g, c);
    emitirDiretorio();

    if (!donos[g]) {
      atribuirAdmin(g, socket.id);
    } else if (donos[g] === socket.id) {
      socket.emit('adminStatus', { isAdmin: true, grupo: g });
    } else {
      socket.emit('adminStatus', { isAdmin: false, grupo: g });
    }

    // Sincronizar estado de visibilidade dos canais do grupo
    if (ocultados[g]) {
      for (const [c2, oculto] of Object.entries(ocultados[g])) {
        if (oculto) socket.emit('visibilidadeCanal', { grupo: g, canal: c2, oculto: true });
      }
    }

    console.log(`${socket.id} entrou em "${g}/${c}" (${clientes[g][c].size} conectado(s))`);
  });

  // ── updateTextoGlobal ────────────────────────────────────────────────────
  socket.on('updateTextoGlobal', ({ grupo, canal, texto }) => {
    if (typeof grupo !== 'string' || typeof canal !== 'string') return;
    const g = grupo.trim(), c = canal.trim();
    if (!g || !c) return;

    if (!textos[g]) textos[g] = {};
    textos[g][c] = texto;

    // Canal recebeu texto: cancelar o timer de "sem texto"
    if (texto && texto.trim()) cancelarTimerSemTexto(g, c);

    socket.to(chaveRoom(g, c)).emit('update', texto);
    io.emit('canalAtualizado', { grupo: g, canal: c });
    agendarHistorico(g, c);
  });

  // ── toggleVisibilidadeCanal ──────────────────────────────────────────────
  socket.on('toggleVisibilidadeCanal', ({ grupo, canal }) => {
    if (typeof grupo !== 'string' || typeof canal !== 'string') return;
    const g = grupo.trim(), c = canal.trim();
    if (!g || !c) return;
    if (donos[g] !== socket.id) return;

    if (!ocultados[g]) ocultados[g] = {};
    ocultados[g][c] = !ocultados[g][c];
    const oculto = !!ocultados[g][c];

    for (const canalGrupo of Object.keys(clientes[g] ?? {})) {
      io.to(chaveRoom(g, canalGrupo)).emit('visibilidadeCanal', { grupo: g, canal: c, oculto });
    }

    emitirDiretorio();
    console.log(`Admin ${oculto ? 'ocultou' : 'exibiu'} canal "${g}/${c}"`);
  });

  // ── excluirCanal ─────────────────────────────────────────────────────────
  socket.on('excluirCanal', ({ grupo, canal }) => {
    if (typeof grupo !== 'string' || typeof canal !== 'string') return;
    const g = grupo.trim(), c = canal.trim();
    if (!g || !c) return;
    if (donos[g] !== socket.id) return;

    const canaisRestantes = getCanaisDoGrupo(g).filter(x => x !== c);
    io.to(chaveRoom(g, c)).emit('canalExcluido', { grupo: g, canal: c, canaisRestantes });

    limparCanal(g, c);
    cancelarTimer(g, c);
    emitirDiretorio();
    agendarVerificacaoGrupoVazio(g);
    console.log(`Admin excluiu canal "${g}/${c}". Restantes: [${canaisRestantes}]`);
  });

  // ── excluirGrupo ─────────────────────────────────────────────────────────
  socket.on('excluirGrupo', ({ grupo }) => {
    if (typeof grupo !== 'string') return;
    const g = grupo.trim();
    if (!g) return;
    if (donos[g] !== socket.id) return;

    cancelarTimerGrupoVazio(g);
    io.emit('grupoExcluido', { grupo: g });

    for (const c of Object.keys(clientes[g] ?? {})) limparCanal(g, c);
    for (const c of Object.keys(timers[g] ?? {})) cancelarTimer(g, c);
    delete clientes[g];
    delete textos[g];
    delete historico[g];
    delete timers[g];
    delete donos[g];
    delete ocultados[g];

    emitirDiretorio();
    console.log(`Admin excluiu grupo "${g}".`);
  });

  // ── disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('Desconectou:', socket.id);
    delete criacoesPorSocket[socket.id];
    if (grupoAtual && canalAtual && clientes[grupoAtual]?.[canalAtual]) {
      clientes[grupoAtual][canalAtual].delete(socket.id);
      emitirInfoCanal(grupoAtual, canalAtual);
      if (getConectados(grupoAtual, canalAtual) === 0) {
        agendarLimpeza(grupoAtual, canalAtual);
        console.log(`"${grupoAtual}/${canalAtual}" entrou em grace period.`);
      }
      if (donos[grupoAtual] === socket.id) transferirAdmin(grupoAtual, socket.id);
      emitirDiretorio();
    }
  });
});

server.listen(PORT, () => console.log('Servidor rodando na porta', PORT));
