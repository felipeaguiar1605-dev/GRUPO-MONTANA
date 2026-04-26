from django.contrib import admin
from .models import IntegracaoMercadoLivre, PlataformaIntegracao, LogSincronizacao


@admin.register(IntegracaoMercadoLivre)
class IntegracaoMercadoLivreAdmin(admin.ModelAdmin):
    list_display = ('empresa', 'nickname', 'ativa', 'ultima_sincronizacao')
    list_filter = ('ativa',)
    readonly_fields = ('access_token_masked', 'refresh_token_masked')
    exclude = ('access_token', 'refresh_token')

    @admin.display(description='Access Token')
    def access_token_masked(self, obj):
        if obj.access_token:
            return f"{obj.access_token[:10]}...{'*' * 20}"
        return '-'

    @admin.display(description='Refresh Token')
    def refresh_token_masked(self, obj):
        if obj.refresh_token:
            return f"{obj.refresh_token[:10]}...{'*' * 20}"
        return '-'


@admin.register(PlataformaIntegracao)
class PlataformaIntegracaoAdmin(admin.ModelAdmin):
    list_display = ('empresa', 'plataforma', 'ativa', 'ultima_sincronizacao')
    list_filter = ('plataforma', 'ativa')


@admin.register(LogSincronizacao)
class LogSincronizacaoAdmin(admin.ModelAdmin):
    list_display = ('integracao', 'tipo', 'status', 'registros_processados', 'created_at')
    list_filter = ('tipo', 'status')

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_readonly_fields(self, request, obj=None):
        return [f.name for f in self.model._meta.fields]
