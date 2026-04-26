from django.db import models
from django.contrib.auth.models import User
from core.models import Empresa
from produtos.models import Produto
from clientes.models import Fornecedor

class Compra(models.Model):
    STATUS_CHOICES = [
        ('cotacao', 'Cotacao'), ('pedido', 'Pedido'), ('recebida', 'Recebida'), ('cancelada', 'Cancelada'),
    ]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='compras')
    numero = models.CharField(max_length=30, blank=True, db_index=True)
    fornecedor = models.ForeignKey(Fornecedor, on_delete=models.SET_NULL, null=True, blank=True)
    usuario = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    data_compra = models.DateTimeField(auto_now_add=True)
    data_entrega = models.DateField(null=True, blank=True)
    subtotal = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    desconto = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    frete = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    total = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    forma_pagamento = models.CharField(max_length=30, blank=True)
    parcelas = models.IntegerField(default=1)
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='pedido')
    observacoes = models.TextField(blank=True)
    nfe_chave = models.CharField(max_length=60, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-data_compra']
        verbose_name_plural = 'Compras'

    def __str__(self):
        return f"Compra {self.numero} - {self.total}"

class CompraItem(models.Model):
    compra = models.ForeignKey(Compra, on_delete=models.CASCADE, related_name='itens')
    produto = models.ForeignKey(Produto, on_delete=models.PROTECT)
    quantidade = models.DecimalField(max_digits=12, decimal_places=2)
    preco_unitario = models.DecimalField(max_digits=12, decimal_places=2)
    desconto = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    total = models.DecimalField(max_digits=12, decimal_places=2)

    def __str__(self):
        return f"{self.produto.nome} x{self.quantidade}"
