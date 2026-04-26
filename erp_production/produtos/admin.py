from django.contrib import admin
from .models import Categoria, Unidade, Produto


@admin.register(Categoria)
class CategoriaAdmin(admin.ModelAdmin):
    list_display = ('nome', 'empresa', 'ativa')
    search_fields = ('nome',)
    list_filter = ('empresa', 'ativa')


@admin.register(Unidade)
class UnidadeAdmin(admin.ModelAdmin):
    list_display = ('sigla', 'descricao')
    search_fields = ('sigla', 'descricao')


@admin.register(Produto)
class ProdutoAdmin(admin.ModelAdmin):
    list_display = ('codigo', 'nome', 'categoria', 'preco_custo', 'preco_venda', 'ml_sync', 'ativo')
    search_fields = ('nome', 'codigo', 'codigo_barras')
    list_filter = ('empresa', 'categoria', 'ativo', 'ml_sync')
    list_editable = ('preco_venda', 'ativo', 'ml_sync')
    list_per_page = 25
    raw_id_fields = ('categoria', 'unidade')
