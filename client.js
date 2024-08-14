const io = require('socket.io-client');

// Substitua a URL pelo endereço do seu servidor Socket.io
//const socket = io('http://localhost:3000');
const socket = io('https://compartilhadortexto-fuf5efeqfjhybte3.brazilsouth-01.azurewebsites.net');

// Evento acionado quando a conexão for estabelecida
socket.on('connect', () => {
  console.log('Conectado ao servidor Socket.io');

  // Enviar uma atualização da variável global
  socket.emit('updateGlobalVariable', 'novo valor');
});

// Evento acionado quando a variável global for atualizada
socket.on('update', (data) => {
  console.log(`Valor atualizado da variável global: ${data}`);
});

// Evento acionado quando a conexão for fechada
socket.on('disconnect', () => {
  console.log('Conexão com o servidor Socket.io foi fechada');
});

// Evento acionado quando ocorre um erro
socket.on('connect_error', (err) => {
  console.error('Erro na conexão com o Socket.io:', err);
});