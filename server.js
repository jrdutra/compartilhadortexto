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

let textoGlobal = '';

io.on('connection', (socket) => {
  console.log('Um cliente se conectou');

  // Enviar a variável global para o cliente ao conectar
  socket.emit('update', textoGlobal);

  // Receber atualização da variável global do cliente
  socket.on('updateTextoGlobal', (newValue) => {
    textoGlobal = newValue;
    io.emit('update', textoGlobal); // Atualiza todos os clientes conectados
  });

  socket.on('disconnect', () => {
    console.log('Um cliente se desconectou');
  });
});

//const io = socketIo(server);
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('Servidor está rodando na porta', PORT);
});