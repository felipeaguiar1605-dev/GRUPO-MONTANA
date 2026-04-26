from django.contrib import admin
from .models import Compra, CompraItem


class CompraItemInline(admin.TabularInline):
    model = CompraItem
    extra = 0
    raw_id_fields = ('produto',)
    readonly_fields = ('total',)


@admin.register(Compra)
class CompraAdmin(admin.ModelAdmin):
    list_display = ('numero', 'fornecedor', 'total', 'status', 'data_compra')
    search_fields = ('numero', 'fornecedor__razao_social', 'nfe_chave')
    list_filter = ('empresa', 'status')
    raw_id_fields = ('fornecedor', 'usuario')
    inlines = [CompraItemInline]
    list_per_page = 25
