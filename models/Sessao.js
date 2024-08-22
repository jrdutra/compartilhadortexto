class Sessao {
    constructor(canal) {
        this.canal = canal;
        this.dataHoraCriacao = new Date();
        this.conteudoTexto = '';
    }

    mostrarDetalhes() {
        console.log(`Canal: ${this.canal}`);
        console.log(`Data e Hora de Criação: ${this.dataHoraCriacao}`);
    }
}