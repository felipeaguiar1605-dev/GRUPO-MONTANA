from django.contrib import admin
from .models import Empresa, PerfilUsuario


@admin.register(Empresa)
class EmpresaAdmin(admin.ModelAdmin):
    list_display = ('nome_fantasia', 'cnpj', 'cidade', 'tipo', 'ativa')
    search_fields = ('nome_fantasia', 'razao_social', 'cnpj')
    list_filter = ('tipo', 'ativa', 'estado')
    list_per_page = 25


@admin.register(PerfilUsuario)
class PerfilUsuarioAdmin(admin.ModelAdmin):
    list_display = ('user', 'perfil', 'empresa_padrao')
    list_filter = ('perfil',)
    search_fields = ('user__username', 'user__first_name', 'user__last_name')
    filter_horizontal = ('empresas',)
    raw_id_fields = ('user', 'empresa_padrao')
