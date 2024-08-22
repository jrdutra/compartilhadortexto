class Sessao {

    constructor(canal) {
        this.canal = canal;
        this.updateClientCanal = `updateClient${canal}`;
        this.updateServerCanal = `updateServer${canal}`;
        this.dataHoraCriacao = new Date();
        this.conteudoTexto = '';
    }

    mostrarDetalhes() {
        console.log(`Canal: ${this.canal}`);
        console.log(`Data e Hora de Criação: ${this.dataHoraCriacao}`);
        return `Criado o canal ${this.canal} em ${this.dataHoraCriacao}`
    }
}