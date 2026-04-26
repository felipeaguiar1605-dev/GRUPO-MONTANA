from django.db import models
from core.models import Empresa

class Categoria(models.Model):
    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='categorias')
    nome = models.CharField(max_length=100)
    descricao = models.TextField(blank=True)
    ativa = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['nome']
        verbose_name_plural = 'Categorias'

    def __str__(self):
        return self.nome

class Unidade(models.Model):
    sigla = models.CharField(max_length=5, unique=True)
    descricao = models.CharField(max_length=50)

    class Meta:
        ordering = ['sigla']

    def __str__(self):
        return f"{self.sigla} - {self.descricao}"

class Produto(models.Model):
    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='produtos')
    codigo = models.CharField(max_length=50, blank=True)
    codigo_barras = models.CharField(max_length=50, blank=True, db_index=True)
    nome = models.CharField(max_length=200)
    descricao = models.TextField(blank=True)
    categoria = models.ForeignKey(Categoria, on_delete=models.SET_NULL, null=True, blank=True)
    unidade = models.ForeignKey(Unidade, on_delete=models.SET_NULL, null=True, blank=True)
    ncm = models.CharField('NCM', max_length=10, blank=True)
    cfop_venda = models.CharField('CFOP Venda', max_length=10, blank=True)
    preco_custo = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    preco_venda = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    preco_atacado = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    margem_lucro = models.DecimalField(max_digits=6, decimal_places=2, default=0)
    estoque_minimo = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    estoque_maximo = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    localizacao = models.CharField(max_length=50, blank=True)
    peso = models.DecimalField(max_digits=10, decimal_places=3, default=0)
    foto = models.ImageField(upload_to='produtos/', blank=True, null=True)
    ativo = models.BooleanField(default=True)
    # Mercado Livre
    ml_id = models.CharField('ID Mercado Livre', max_length=50, blank=True, db_index=True)
    ml_permalink = models.URLField('Link ML', blank=True)
    ml_sync = models.BooleanField('Sincronizar ML', default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['nome']
        verbose_name_plural = 'Produtos'
        indexes = [
            models.Index(fields=['empresa', 'codigo']),
            models.Index(fields=['empresa', 'ativo']),
        ]

    def __str__(self):
        return f"{self.codigo} - {self.nome}" if self.codigo else self.nome
