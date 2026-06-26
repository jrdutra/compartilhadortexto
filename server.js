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

// Middleware para pré-requisições CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const PORT = process.env.PORT || 3000;

// Estrutura: textos[grupo][canal] = string
const textos = {};

// Estrutura: clientes[grupo][canal] = Set<socketId>
const clientes = {};

function chaveRoom(grupo, canal) {
  return `${grupo}::${canal}`;
}

function getConectados(grupo, canal) {
  return clientes[grupo]?.[canal]?.size ?? 0;
}

function limparCanalSeVazio(grupo, canal) {
  if (getConectados(grupo, canal) === 0) {
    // Apaga texto e entrada do canal
    if (clientes[grupo]) {
      delete clientes[grupo][canal];
      if (Object.keys(clientes[grupo]).length === 0) {
        delete clientes[grupo];
      }
    }
    if (textos[grupo]) {
      delete textos[grupo][canal];
      if (Object.keys(textos[grupo]).length === 0) {
        delete textos[grupo];
      }
    }
  }
}

function emitirInfoCanal(grupo, canal) {
  const conectados = getConectados(grupo, canal);
  io.to(chaveRoom(grupo, canal)).emit('canalInfo', { conectados });
}

function buildDiretorio() {
  const dir = {};
  for (const grupo of Object.keys(clientes)) {
    const canais = Object.keys(clientes[grupo]).filter(
      (canal) => (clientes[grupo][canal]?.size ?? 0) > 0
    );
    if (canais.length > 0) {
      dir[grupo] = canais;
    }
  }
  return dir;
}

function emitirDiretorio() {
  io.emit('diretorioAtualizado', buildDiretorio());
}

io.on('connection', (socket) => {
  console.log('Um cliente se conectou:', socket.id);

  let grupoAtual = null;
  let canalAtual = null;

  // Enviar diretório atual ao conectar
  socket.emit('diretorioAtualizado', buildDiretorio());

  // Cliente entra em um canal de um grupo
  socket.on('joinCanal', ({ grupo, canal }) => {
    if (!grupo || typeof grupo !== 'string') return;
    if (!canal || typeof canal !== 'string') return;

    const grupoTrim = grupo.trim();
    const canalTrim = canal.trim();
    if (!grupoTrim || !canalTrim) return;

    // Sair do canal anterior
    if (grupoAtual && canalAtual) {
      socket.leave(chaveRoom(grupoAtual, canalAtual));
      if (clientes[grupoAtual]?.[canalAtual]) {
        clientes[grupoAtual][canalAtual].delete(socket.id);
        emitirInfoCanal(grupoAtual, canalAtual);
        limparCanalSeVazio(grupoAtual, canalAtual);
        emitirDiretorio();
      }
    }

    grupoAtual = grupoTrim;
    canalAtual = canalTrim;

    const room = chaveRoom(grupoAtual, canalAtual);
    socket.join(room);

    if (!clientes[grupoAtual]) clientes[grupoAtual] = {};
    if (!clientes[grupoAtual][canalAtual]) clientes[grupoAtual][canalAtual] = new Set();
    clientes[grupoAtual][canalAtual].add(socket.id);

    // Enviar texto atual do canal
    const textoAtual = textos[grupoAtual]?.[canalAtual] ?? '';
    socket.emit('update', textoAtual);

    // Notificar todos no canal
    emitirInfoCanal(grupoAtual, canalAtual);

    // Atualizar diretório para todos
    emitirDiretorio();

    console.log(`Cliente ${socket.id} entrou em "${grupoAtual}/${canalAtual}" (${clientes[grupoAtual][canalAtual].size} conectado(s))`);
  });

  // Receber atualização de texto
  socket.on('updateTextoGlobal', ({ grupo, canal, texto }) => {
    if (!grupo || typeof grupo !== 'string') return;
    if (!canal || typeof canal !== 'string') return;

    const grupoTrim = grupo.trim();
    const canalTrim = canal.trim();
    if (!grupoTrim || !canalTrim) return;

    if (!textos[grupoTrim]) textos[grupoTrim] = {};
    textos[grupoTrim][canalTrim] = texto;

    socket.to(chaveRoom(grupoTrim, canalTrim)).emit('update', texto);
  });

  socket.on('disconnect', () => {
    console.log('Um cliente se desconectou:', socket.id);
    if (grupoAtual && canalAtual) {
      if (clientes[grupoAtual]?.[canalAtual]) {
        clientes[grupoAtual][canalAtual].delete(socket.id);
        emitirInfoCanal(grupoAtual, canalAtual);
        limparCanalSeVazio(grupoAtual, canalAtual);
        emitirDiretorio();
        console.log(`Canal "${grupoAtual}/${canalAtual}" agora tem ${getConectados(grupoAtual, canalAtual)} conectado(s)`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log('Servidor está rodando na porta', PORT);
});
