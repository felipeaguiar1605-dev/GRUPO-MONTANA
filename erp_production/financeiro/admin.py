from django.contrib import admin
from .models import ContaPagar, ContaReceber, FluxoCaixa


@admin.register(ContaPagar)
class ContaPagarAdmin(admin.ModelAdmin):
    list_display = ('descricao', 'fornecedor', 'valor', 'data_vencimento', 'status')
    search_fields = ('descricao', 'fornecedor__razao_social', 'documento')
    list_filter = ('empresa', 'status')
    raw_id_fields = ('fornecedor', 'compra')
    list_per_page = 25


@admin.register(ContaReceber)
class ContaReceberAdmin(admin.ModelAdmin):
    list_display = ('descricao', 'cliente', 'valor', 'data_vencimento', 'status')
    search_fields = ('descricao', 'cliente__nome', 'documento')
    list_filter = ('empresa', 'status')
    raw_id_fields = ('cliente', 'venda')
    list_per_page = 25


@admin.register(FluxoCaixa)
class FluxoCaixaAdmin(admin.ModelAdmin):
    list_display = ('descricao', 'tipo', 'valor', 'data_movimento')
    search_fields = ('descricao',)
    list_filter = ('empresa', 'tipo')
    list_per_page = 25
