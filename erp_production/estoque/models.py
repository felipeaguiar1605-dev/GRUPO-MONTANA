from django.db import models
from django.contrib.auth.models import User
from core.models import Empresa
from produtos.models import Produto

class Estoque(models.Model):
    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE)
    produto = models.ForeignKey(Produto, on_delete=models.CASCADE, related_name='estoques')
    quantidade = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ['empresa', 'produto']
        verbose_name_plural = 'Estoques'

    def __str__(self):
        return f"{self.produto.nome}: {self.quantidade}"

    @property
    def abaixo_minimo(self):
        return self.quantidade <= self.produto.estoque_minimo and self.produto.estoque_minimo > 0

class MovimentacaoEstoque(models.Model):
    TIPO_CHOICES = [
        ('entrada', 'Entrada'), ('saida', 'Saida'), ('ajuste', 'Ajuste'),
        ('transferencia', 'Transferencia'), ('devolucao', 'Devolucao'),
    ]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE)
    produto = models.ForeignKey(Produto, on_delete=models.CASCADE, related_name='movimentacoes')
    tipo = models.CharField(max_length=15, choices=TIPO_CHOICES)
    quantidade = models.DecimalField(max_digits=12, decimal_places=2)
    quantidade_anterior = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    quantidade_posterior = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    custo_unitario = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    documento_tipo = models.CharField(max_length=20, blank=True)
    documento_id = models.IntegerField(null=True, blank=True)
    observacao = models.TextField(blank=True)
    usuario = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = 'Movimentacao de Estoque'
        verbose_name_plural = 'Movimentacoes de Estoque'

    def __str__(self):
        return f"{self.get_tipo_display()} - {self.produto.nome}: {self.quantidade}"
