from django.db import models
from core.models import Empresa

class IntegracaoMercadoLivre(models.Model):
    empresa = models.OneToOneField(Empresa, on_delete=models.CASCADE, related_name='ml_integracao')
    ml_user_id = models.CharField('User ID ML', max_length=50)
    access_token = models.TextField()
    refresh_token = models.TextField()
    token_expira = models.DateTimeField()
    nickname = models.CharField(max_length=100, blank=True)
    ativa = models.BooleanField(default=True)
    ultima_sincronizacao = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Integracao Mercado Livre'
        verbose_name_plural = 'Integracoes Mercado Livre'

    def __str__(self):
        return f"ML - {self.empresa.nome_fantasia} ({self.nickname})"

class PlataformaIntegracao(models.Model):
    PLATAFORMA_CHOICES = [
        ('mercadolivre', 'Mercado Livre'),
        ('shopee', 'Shopee'),
        ('magazineluiza', 'Magazine Luiza'),
        ('amazon', 'Amazon'),
        ('americanas', 'Americanas'),
        ('maxdata', 'Maxdata (Importacao)'),
    ]

    empresa = models.ForeignKey(Empresa, on_delete=models.CASCADE, related_name='integracoes')
    plataforma = models.CharField(max_length=20, choices=PLATAFORMA_CHOICES)
    ativa = models.BooleanField(default=False)
    configuracao = models.JSONField(default=dict, blank=True)
    ultima_sincronizacao = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ['empresa', 'plataforma']
        verbose_name = 'Plataforma de Integracao'
        verbose_name_plural = 'Plataformas de Integracao'

    def __str__(self):
        return f"{self.get_plataforma_display()} - {self.empresa.nome_fantasia}"

class LogSincronizacao(models.Model):
    TIPO_CHOICES = [('produtos','Produtos'), ('pedidos','Pedidos'), ('estoque','Estoque'), ('precos','Precos')]
    STATUS_CHOICES = [('sucesso','Sucesso'), ('erro','Erro'), ('parcial','Parcial')]

    integracao = models.ForeignKey(PlataformaIntegracao, on_delete=models.CASCADE, related_name='logs')
    tipo = models.CharField(max_length=20, choices=TIPO_CHOICES)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES)
    registros_processados = models.IntegerField(default=0)
    registros_erro = models.IntegerField(default=0)
    detalhes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        verbose_name = 'Log de Sincronizacao'
        verbose_name_plural = 'Logs de Sincronizacao'

    def __str__(self):
        return f"{self.get_tipo_display()} - {self.get_status_display()} ({self.created_at})"
