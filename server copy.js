const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

let textoGlobal = '';

// Endpoint de healthcheck
app.get('/healthcheck', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Configurar CORS para Socket.IO
io.origins('*');

io.on('connection', (socket) => {
  console.log('Um cliente se conectou');

  // Enviar a variável global para o cliente ao conectar
  socket.emit('update', textoGlobal);

  // Receber atualização da variável global do cliente
  socket.on('updateTextoGlobal', (newValue) => {
    console.log('Recebeu: ', newValue);
    textoGlobal = newValue;
    io.emit('update', textoGlobal); // Atualiza todos os clientes conectados
  });

  socket.on('disconnect', () => {
    console.log('Um cliente se desconectou');
  });
});

server.listen(PORT, () => {
  console.log('Servidor está rodando na porta', PORT);
});