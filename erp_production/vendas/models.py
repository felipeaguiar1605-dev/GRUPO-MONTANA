from django.db import models
from django.contrib.auth.models import User
from core.models import Empresa
from produtos.models import Produto
from clientes.models import Cliente, Vendedor

class Venda(models.Model):
    TIPO_CHOICES = [('varejo', 'Varejo'), ('atacado', 'Atacado')]
    PAGAMENTO_CHOICES = [
        ('dinheiro', 'Dinheiro'), ('pix', 'PIX'), ('cartao_debito', 'Cartao Debito'),
        ('cartao_credito', 'Cartao Credito'), ('boleto', 'Boleto'), ('prazo', 'A Prazo'), ('cheque', 'Cheque'),
    ]
    STATUS_CHOICES = [
        ('aberta', 'Aberta'), ('finalizada', 'Finalizada'), ('cancelada', 'Cancelada'), ('devolvida', 'Devolvida'),
    ]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='vendas')
    numero = models.CharField(max_length=30, blank=True, db_index=True)
    cliente = models.ForeignKey(Cliente, on_delete=models.SET_NULL, null=True, blank=True)
    vendedor = models.ForeignKey(Vendedor, on_delete=models.SET_NULL, null=True, blank=True)
    usuario = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    data_venda = models.DateTimeField(auto_now_add=True)
    tipo = models.CharField(max_length=10, choices=TIPO_CHOICES, default='varejo')
    subtotal = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    desconto_percentual = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    desconto_valor = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    acrescimo = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    total = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    forma_pagamento = models.CharField(max_length=20, choices=PAGAMENTO_CHOICES, default='dinheiro')
    parcelas = models.IntegerField(default=1)
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='aberta')
    observacoes = models.TextField(blank=True)
    nfe_numero = models.CharField(max_length=50, blank=True)
    nfe_status = models.CharField(max_length=30, blank=True)
    # Mercado Livre
    ml_order_id = models.CharField('ID Pedido ML', max_length=50, blank=True, db_index=True)
    ml_pack_id = models.CharField('ID Pack ML', max_length=50, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-data_venda']
        verbose_name_plural = 'Vendas'
        indexes = [
            models.Index(fields=['empresa', 'status']),
            models.Index(fields=['empresa', 'data_venda']),
        ]

    def __str__(self):
        return f"Venda {self.numero} - {self.total}"

class VendaItem(models.Model):
    venda = models.ForeignKey(Venda, on_delete=models.CASCADE, related_name='itens')
    produto = models.ForeignKey(Produto, on_delete=models.PROTECT)
    quantidade = models.DecimalField(max_digits=12, decimal_places=2)
    preco_unitario = models.DecimalField(max_digits=12, decimal_places=2)
    desconto = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    total = models.DecimalField(max_digits=12, decimal_places=2)
    comissao_percentual = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    comissao_valor = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    def __str__(self):
        return f"{self.produto.nome} x{self.quantidade}"

class Comissao(models.Model):
    STATUS_CHOICES = [('pendente', 'Pendente'), ('paga', 'Paga'), ('cancelada', 'Cancelada')]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE)
    vendedor = models.ForeignKey(Vendedor, on_delete=models.CASCADE, related_name='comissoes')
    venda = models.ForeignKey(Venda, on_delete=models.CASCADE, related_name='comissoes')
    valor = models.DecimalField(max_digits=12, decimal_places=2)
    percentual = models.DecimalField(max_digits=5, decimal_places=2)
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='pendente')
    data_pagamento = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name_plural = 'Comissoes'
        verbose_name = 'Comissao'

    def __str__(self):
        return f"Comissao {self.vendedor.nome} - {self.valor}"
