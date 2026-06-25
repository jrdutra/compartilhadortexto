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

// Texto atual por canal
const textosPorCanal = {};

// Contagem de clientes por canal
const clientesPorCanal = {};

function emitirInfoCanal(canal) {
  const conectados = clientesPorCanal[canal] ? clientesPorCanal[canal].size : 0;
  io.to(canal).emit('canalInfo', { conectados });
}

io.on('connection', (socket) => {
  console.log('Um cliente se conectou:', socket.id);

  let canalAtual = null;

  // Cliente entra em um canal
  socket.on('joinCanal', (canal) => {
    if (!canal || typeof canal !== 'string') return;

    // Sair do canal anterior
    if (canalAtual) {
      socket.leave(canalAtual);
      if (clientesPorCanal[canalAtual]) {
        clientesPorCanal[canalAtual].delete(socket.id);
        emitirInfoCanal(canalAtual);
      }
    }

    canalAtual = canal.trim();
    socket.join(canalAtual);

    if (!clientesPorCanal[canalAtual]) {
      clientesPorCanal[canalAtual] = new Set();
    }
    clientesPorCanal[canalAtual].add(socket.id);

    // Enviar texto atual do canal para o cliente que entrou
    socket.emit('update', textosPorCanal[canalAtual] || '');

    // Notificar todos no canal sobre nova contagem
    emitirInfoCanal(canalAtual);

    console.log(`Cliente ${socket.id} entrou no canal "${canalAtual}" (${clientesPorCanal[canalAtual].size} conectado(s))`);
  });

  // Receber atualização de texto do cliente
  socket.on('updateTextoGlobal', ({ canal, texto }) => {
    if (!canal || typeof canal !== 'string') return;
    textosPorCanal[canal.trim()] = texto;
    // Transmitir para todos no canal, exceto o remetente
    socket.to(canal.trim()).emit('update', texto);
  });

  socket.on('disconnect', () => {
    console.log('Um cliente se desconectou:', socket.id);
    if (canalAtual && clientesPorCanal[canalAtual]) {
      clientesPorCanal[canalAtual].delete(socket.id);
      emitirInfoCanal(canalAtual);
      console.log(`Canal "${canalAtual}" agora tem ${clientesPorCanal[canalAtual].size} conectado(s)`);
    }
  });
});

server.listen(PORT, () => {
  console.log('Servidor está rodando na porta', PORT);
});