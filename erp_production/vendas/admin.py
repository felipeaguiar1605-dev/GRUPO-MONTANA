from django.contrib import admin
from .models import Venda, VendaItem, Comissao


class VendaItemInline(admin.TabularInline):
    model = VendaItem
    extra = 0
    raw_id_fields = ('produto',)
    readonly_fields = ('total',)


@admin.register(Venda)
class VendaAdmin(admin.ModelAdmin):
    list_display = ('numero', 'cliente', 'vendedor', 'total', 'forma_pagamento', 'status', 'data_venda')
    search_fields = ('numero', 'cliente__nome', 'vendedor__nome')
    list_filter = ('empresa', 'status', 'forma_pagamento')
    raw_id_fields = ('cliente', 'vendedor', 'usuario')
    inlines = [VendaItemInline]
    list_per_page = 25


@admin.register(Comissao)
class ComissaoAdmin(admin.ModelAdmin):
    list_display = ('vendedor', 'venda', 'valor', 'percentual', 'status')
    search_fields = ('vendedor__nome', 'venda__numero')
    list_filter = ('empresa', 'status')
    raw_id_fields = ('vendedor', 'venda')
    list_per_page = 25
