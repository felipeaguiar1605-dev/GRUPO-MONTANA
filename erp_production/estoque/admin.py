from django.contrib import admin
from .models import Estoque, MovimentacaoEstoque


@admin.register(Estoque)
class EstoqueAdmin(admin.ModelAdmin):
    list_display = ('produto', 'empresa', 'quantidade', 'updated_at')
    search_fields = ('produto__nome', 'produto__codigo')
    list_filter = ('empresa',)
    readonly_fields = ('updated_at',)
    raw_id_fields = ('produto',)
    list_per_page = 25


@admin.register(MovimentacaoEstoque)
class MovimentacaoEstoqueAdmin(admin.ModelAdmin):
    list_display = ('produto', 'tipo', 'quantidade', 'usuario', 'created_at')
    search_fields = ('produto__nome', 'produto__codigo', 'observacao')
    list_filter = ('empresa', 'tipo')
    readonly_fields = ('created_at',)
    raw_id_fields = ('produto', 'usuario')
    list_per_page = 25
