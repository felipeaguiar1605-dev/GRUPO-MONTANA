from django.contrib import admin
from .models import Cliente, Fornecedor, Vendedor


@admin.register(Cliente)
class ClienteAdmin(admin.ModelAdmin):
    list_display = ('nome', 'cpf_cnpj', 'telefone', 'cidade', 'ativo')
    search_fields = ('nome', 'cpf_cnpj', 'email', 'telefone')
    list_filter = ('empresa', 'tipo_pessoa', 'ativo')
    list_per_page = 25


@admin.register(Fornecedor)
class FornecedorAdmin(admin.ModelAdmin):
    list_display = ('razao_social', 'cnpj', 'telefone', 'cidade', 'ativo')
    search_fields = ('razao_social', 'nome_fantasia', 'cnpj', 'email')
    list_filter = ('empresa', 'ativo')
    list_per_page = 25


@admin.register(Vendedor)
class VendedorAdmin(admin.ModelAdmin):
    list_display = ('nome', 'cpf', 'comissao_percentual', 'meta_mensal', 'ativo')
    search_fields = ('nome', 'cpf', 'email')
    list_filter = ('empresa', 'ativo')
    list_per_page = 25
