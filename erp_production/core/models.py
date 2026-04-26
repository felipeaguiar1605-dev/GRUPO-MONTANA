from django.db import models
from django.contrib.auth.models import User

class Empresa(models.Model):
    TIPO_CHOICES = [('atacado', 'Atacado'), ('varejo', 'Varejo'), ('ambos', 'Atacado & Varejo')]

    razao_social = models.CharField(max_length=200)
    nome_fantasia = models.CharField(max_length=200)
    cnpj = models.CharField(max_length=20, unique=True)
    inscricao_estadual = models.CharField(max_length=30, blank=True)
    endereco = models.CharField(max_length=300, blank=True)
    cidade = models.CharField(max_length=100, blank=True)
    estado = models.CharField(max_length=2, default='GO')
    cep = models.CharField(max_length=10, blank=True)
    telefone = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)
    tipo = models.CharField(max_length=10, choices=TIPO_CHOICES, default='ambos')
    ativa = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name_plural = 'Empresas'
        ordering = ['nome_fantasia']

    def __str__(self):
        return self.nome_fantasia

class PerfilUsuario(models.Model):
    PERFIL_CHOICES = [('admin','Administrador'), ('gerente','Gerente'), ('vendedor','Vendedor'), ('caixa','Caixa'), ('estoquista','Estoquista')]

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='perfil')
    empresas = models.ManyToManyField(Empresa, related_name='usuarios')
    empresa_padrao = models.ForeignKey(Empresa, on_delete=models.SET_NULL, null=True, blank=True, related_name='usuarios_padrao')
    perfil = models.CharField(max_length=20, choices=PERFIL_CHOICES, default='vendedor')
    telefone = models.CharField(max_length=20, blank=True)

    class Meta:
        verbose_name = 'Perfil de Usuario'
        verbose_name_plural = 'Perfis de Usuarios'

    def __str__(self):
        return f"{self.user.get_full_name()} - {self.get_perfil_display()}"
