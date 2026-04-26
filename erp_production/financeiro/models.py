from django.db import models
from django.contrib.auth.models import User
from core.models import Empresa
from clientes.models import Cliente, Fornecedor

class ContaPagar(models.Model):
    STATUS_CHOICES = [('pendente', 'Pendente'), ('paga', 'Paga'), ('vencida', 'Vencida'), ('cancelada', 'Cancelada')]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='contas_pagar')
    fornecedor = models.ForeignKey(Fornecedor, on_delete=models.SET_NULL, null=True, blank=True)
    compra = models.ForeignKey('compras.Compra', on_delete=models.SET_NULL, null=True, blank=True)
    descricao = models.CharField(max_length=200)
    categoria = models.CharField(max_length=100, blank=True)
    valor = models.DecimalField(max_digits=12, decimal_places=2)
    data_emissao = models.DateField()
    data_vencimento = models.DateField()
    data_pagamento = models.DateField(null=True, blank=True)
    valor_pago = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    juros = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    multa = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    desconto = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    forma_pagamento = models.CharField(max_length=30, blank=True)
    documento = models.CharField(max_length=50, blank=True)
    parcela = models.IntegerField(default=1)
    total_parcelas = models.IntegerField(default=1)
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='pendente')
    observacoes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['data_vencimento']
        verbose_name = 'Conta a Pagar'
        verbose_name_plural = 'Contas a Pagar'

    def __str__(self):
        return f"{self.descricao} - {self.valor}"

class ContaReceber(models.Model):
    STATUS_CHOICES = [('pendente', 'Pendente'), ('recebida', 'Recebida'), ('vencida', 'Vencida'), ('cancelada', 'Cancelada')]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='contas_receber')
    cliente = models.ForeignKey(Cliente, on_delete=models.SET_NULL, null=True, blank=True)
    venda = models.ForeignKey('vendas.Venda', on_delete=models.SET_NULL, null=True, blank=True)
    descricao = models.CharField(max_length=200)
    categoria = models.CharField(max_length=100, blank=True)
    valor = models.DecimalField(max_digits=12, decimal_places=2)
    data_emissao = models.DateField()
    data_vencimento = models.DateField()
    data_recebimento = models.DateField(null=True, blank=True)
    valor_recebido = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    juros = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    multa = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    desconto = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    forma_pagamento = models.CharField(max_length=30, blank=True)
    documento = models.CharField(max_length=50, blank=True)
    parcela = models.IntegerField(default=1)
    total_parcelas = models.IntegerField(default=1)
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='pendente')
    observacoes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['data_vencimento']
        verbose_name = 'Conta a Receber'
        verbose_name_plural = 'Contas a Receber'

    def __str__(self):
        return f"{self.descricao} - {self.valor}"

class FluxoCaixa(models.Model):
    TIPO_CHOICES = [('entrada', 'Entrada'), ('saida', 'Saida')]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE)
    tipo = models.CharField(max_length=10, choices=TIPO_CHOICES)
    categoria = models.CharField(max_length=100, blank=True)
    descricao = models.CharField(max_length=200)
    valor = models.DecimalField(max_digits=12, decimal_places=2)
    data_movimento = models.DateField()
    forma_pagamento = models.CharField(max_length=30, blank=True)
    documento_tipo = models.CharField(max_length=20, blank=True)
    documento_id = models.IntegerField(null=True, blank=True)
    usuario = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    observacoes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-data_movimento']
        verbose_name = 'Fluxo de Caixa'
        verbose_name_plural = 'Fluxo de Caixa'

    def __str__(self):
        return f"{self.get_tipo_display()} - {self.descricao}: {self.valor}"
