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
const GRACE_PERIOD_MS   = 5  * 60 * 1000;
const DEBOUNCE_HIST_MS  = 10 * 1000;
const MAX_HISTORICO     = 100;

// Rate limits
const LIMITE_SOCKET_CANAIS = 20;
const JANELA_SOCKET_MS     = 5  * 60 * 1000;  // 5 min por socket
const LIMITE_GRUPO_CANAIS  = 100;
const JANELA_GRUPO_MS      = 10 * 60 * 1000;  // 10 min por grupo

const textos    = {};   // textos[grupo][canal] = string
const clientes  = {};   // clientes[grupo][canal] = Set<socketId>
const timers    = {};   // timers[grupo][canal] = timeoutId (grace period)
const historico = {};   // historico[grupo][canal] = [ISO, ...]
const debounceHist = {}; // debounceHist[grupo][canal] = timeoutId
const donos     = {};   // donos[grupo] = socketId (admin)

// Rate limiting
const banidos           = new Set();  // socketIds banidos
const criacoesPorSocket = {};         // socketId -> [timestamp, ...]
const criacoesPorGrupo  = {};         // grupo -> [{canal, timestamp}, ...]

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Admin ──────────────────────────────────────────────────────────────────

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

// ─── Grace period ────────────────────────────────────────────────────────────

function cancelarTimer(grupo, canal) {
  if (timers[grupo]?.[canal]) {
    clearTimeout(timers[grupo][canal]);
    delete timers[grupo][canal];
    if (!Object.keys(timers[grupo]).length) delete timers[grupo];
  }
}

function limparCanal(grupo, canal) {
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
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

function registrarCriacaoCanal(socketId, grupo, canal) {
  const agora = Date.now();
  const isAdminDoGrupo = donos[grupo] === socketId;

  // ── Limite por socket (não-admins) ──────────────────────────────────────
  if (!isAdminDoGrupo) {
    if (!criacoesPorSocket[socketId]) criacoesPorSocket[socketId] = [];
    // Limpar entradas fora da janela
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

  // ── Limite por grupo ────────────────────────────────────────────────────
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
    return 'spam_grupo';
  }

  return 'ok';
}

function agendarLimpeza(grupo, canal) {
  cancelarTimer(grupo, canal);
  if (!timers[grupo]) timers[grupo] = {};
  timers[grupo][canal] = setTimeout(() => {
    if (getConectados(grupo, canal) === 0) {
      limparCanal(grupo, canal);
      emitirDiretorio();
      console.log(`Canal "${grupo}/${canal}" expirou após grace period.`);
    }
  }, GRACE_PERIOD_MS);
}

// ─── Histórico ───────────────────────────────────────────────────────────────

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

// ─── Diretório ───────────────────────────────────────────────────────────────

function emitirInfoCanal(grupo, canal) {
  io.to(chaveRoom(grupo, canal)).emit('canalInfo', { conectados: getConectados(grupo, canal) });
}

function buildDiretorio() {
  const dir = {};
  const grupos = new Set([...Object.keys(clientes), ...Object.keys(timers)]);
  for (const grupo of grupos) {
    const canais = getCanaisDoGrupo(grupo);
    if (canais.length) dir[grupo] = canais;
  }
  return dir;
}

function emitirDiretorio() { io.emit('diretorioAtualizado', buildDiretorio()); }

// ─── Socket ──────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Conectou:', socket.id);

  let grupoAtual = null;
  let canalAtual = null;

  socket.emit('diretorioAtualizado', buildDiretorio());

  // ── joinCanal ────────────────────────────────────────────────────────────
  socket.on('joinCanal', ({ grupo, canal }) => {
    if (typeof grupo !== 'string' || typeof canal !== 'string') return;
    const g = grupo.trim(), c = canal.trim();
    if (!g || !c) return;

    // Verificar ban
    if (banidos.has(socket.id)) {
      socket.emit('banido', { motivo: 'Sessão bloqueada por criação excessiva de canais.' });
      return;
    }

    // Verificar se é um canal novo (antes de qualquer alteração)
    const canalNovo = !getCanaisDoGrupo(g).includes(c);

    // Sair do canal anterior
    if (grupoAtual && canalAtual) {
      socket.leave(chaveRoom(grupoAtual, canalAtual));
      if (clientes[grupoAtual]?.[canalAtual]) {
        clientes[grupoAtual][canalAtual].delete(socket.id);
        emitirInfoCanal(grupoAtual, canalAtual);
        if (getConectados(grupoAtual, canalAtual) === 0) agendarLimpeza(grupoAtual, canalAtual);
      }
      // Se mudou de grupo, transferir admin do grupo anterior
      if (grupoAtual !== g && donos[grupoAtual] === socket.id) {
        transferirAdmin(grupoAtual, socket.id);
        socket.emit('adminStatus', { isAdmin: false, grupo: grupoAtual });
      }
      emitirDiretorio();
    }

    // Rate limiting para canais novos
    if (canalNovo) {
      const resultado = registrarCriacaoCanal(socket.id, g, c);
      if (resultado === 'banido' || resultado === 'spam_grupo') return;
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

    // Admin: primeiro a entrar no grupo torna-se dono
    if (!donos[g]) {
      atribuirAdmin(g, socket.id);
    } else if (donos[g] === socket.id) {
      socket.emit('adminStatus', { isAdmin: true, grupo: g });
    } else {
      socket.emit('adminStatus', { isAdmin: false, grupo: g });
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
    socket.to(chaveRoom(g, c)).emit('update', texto);
    io.emit('canalAtualizado', { grupo: g, canal: c });
    agendarHistorico(g, c);
  });

  // ── excluirCanal ─────────────────────────────────────────────────────────
  socket.on('excluirCanal', ({ grupo, canal }) => {
    if (typeof grupo !== 'string' || typeof canal !== 'string') return;
    const g = grupo.trim(), c = canal.trim();
    if (!g || !c) return;
    if (donos[g] !== socket.id) return; // somente admin

    const canaisRestantes = getCanaisDoGrupo(g).filter(x => x !== c);
    io.to(chaveRoom(g, c)).emit('canalExcluido', { grupo: g, canal: c, canaisRestantes });

    limparCanal(g, c);
    cancelarTimer(g, c);
    emitirDiretorio();
    console.log(`Admin excluiu canal "${g}/${c}". Restantes: [${canaisRestantes}]`);
  });

  // ── excluirGrupo ─────────────────────────────────────────────────────────
  socket.on('excluirGrupo', ({ grupo }) => {
    if (typeof grupo !== 'string') return;
    const g = grupo.trim();
    if (!g) return;
    if (donos[g] !== socket.id) return; // somente admin

    // Notificar todos os canais do grupo
    for (const c of getCanaisDoGrupo(g)) {
      io.to(chaveRoom(g, c)).emit('grupoExcluido', { grupo: g });
    }

    // Limpar tudo do grupo
    for (const c of Object.keys(clientes[g] ?? {})) limparCanal(g, c);
    for (const c of Object.keys(timers[g] ?? {})) cancelarTimer(g, c);
    delete clientes[g];
    delete textos[g];
    delete historico[g];
    delete timers[g];
    delete donos[g];

    emitirDiretorio();
    console.log(`Admin excluiu grupo "${g}".`);
  });

  // ── disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('Desconectou:', socket.id);
    delete criacoesPorSocket[socket.id]; // Limpar histórico de criações
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
