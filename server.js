const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

let globalVariable = 'valor inicial';

// Endpoint de healthcheck
app.get('/healthcheck', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log('Um cliente se conectou');

  // Enviar a variável global para o cliente ao conectar
  socket.emit('update', globalVariable);

  // Receber atualização da variável global do cliente
  socket.on('updateGlobalVariable', (newValue) => {
    globalVariable = newValue;
    io.emit('update', globalVariable); // Atualiza todos os clientes conectados
  });

  socket.on('disconnect', () => {
    console.log('Um cliente se desconectou');
  });
});

server.listen(PORT, () => {
  console.log('Servidor está rodando na porta', PORT);
});