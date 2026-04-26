from django.db import models
from core.models import Empresa

class Cliente(models.Model):
    TIPO_PESSOA = [('PF', 'Pessoa Fisica'), ('PJ', 'Pessoa Juridica')]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='clientes')
    tipo_pessoa = models.CharField(max_length=2, choices=TIPO_PESSOA, default='PF')
    nome = models.CharField(max_length=200)
    cpf_cnpj = models.CharField('CPF/CNPJ', max_length=20, blank=True)
    rg_ie = models.CharField('RG/IE', max_length=20, blank=True)
    email = models.EmailField(blank=True)
    telefone = models.CharField(max_length=20, blank=True)
    celular = models.CharField(max_length=20, blank=True)
    endereco = models.CharField(max_length=300, blank=True)
    numero = models.CharField(max_length=20, blank=True)
    complemento = models.CharField(max_length=100, blank=True)
    bairro = models.CharField(max_length=100, blank=True)
    cidade = models.CharField(max_length=100, blank=True)
    estado = models.CharField(max_length=2, default='GO')
    cep = models.CharField(max_length=10, blank=True)
    limite_credito = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    observacoes = models.TextField(blank=True)
    ativo = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['nome']
        verbose_name_plural = 'Clientes'

    def __str__(self):
        return self.nome

class Fornecedor(models.Model):
    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='fornecedores')
    razao_social = models.CharField(max_length=200)
    nome_fantasia = models.CharField(max_length=200, blank=True)
    cnpj = models.CharField(max_length=20, blank=True)
    inscricao_estadual = models.CharField(max_length=30, blank=True)
    contato = models.CharField(max_length=100, blank=True)
    email = models.EmailField(blank=True)
    telefone = models.CharField(max_length=20, blank=True)
    celular = models.CharField(max_length=20, blank=True)
    endereco = models.CharField(max_length=300, blank=True)
    numero = models.CharField(max_length=20, blank=True)
    complemento = models.CharField(max_length=100, blank=True)
    bairro = models.CharField(max_length=100, blank=True)
    cidade = models.CharField(max_length=100, blank=True)
    estado = models.CharField(max_length=2, blank=True)
    cep = models.CharField(max_length=10, blank=True)
    prazo_entrega = models.IntegerField(default=0)
    condicao_pagamento = models.CharField(max_length=100, blank=True)
    observacoes = models.TextField(blank=True)
    ativo = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['razao_social']
        verbose_name_plural = 'Fornecedores'
        verbose_name = 'Fornecedor'

    def __str__(self):
        return self.nome_fantasia or self.razao_social

class Vendedor(models.Model):
    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='vendedores')
    user = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, blank=True)
    nome = models.CharField(max_length=200)
    cpf = models.CharField(max_length=14, blank=True)
    telefone = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)
    comissao_percentual = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    meta_mensal = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    ativo = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['nome']
        verbose_name_plural = 'Vendedores'
        verbose_name = 'Vendedor'

    def __str__(self):
        return self.nome
