from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from rest_framework.routers import DefaultRouter
from core.api import EmpresaViewSet
from produtos.api import ProdutoViewSet, CategoriaViewSet, UnidadeViewSet
from clientes.api import ClienteViewSet, FornecedorViewSet, VendedorViewSet
from estoque.api import EstoqueViewSet, MovimentacaoEstoqueViewSet
from vendas.api import VendaViewSet, ComissaoViewSet
from compras.api import CompraViewSet
from financeiro.api import ContaPagarViewSet, ContaReceberViewSet, FluxoCaixaViewSet

router = DefaultRouter()
router.register('empresas', EmpresaViewSet, basename='empresa')
router.register('produtos', ProdutoViewSet, basename='produto')
router.register('categorias', CategoriaViewSet, basename='categoria')
router.register('unidades', UnidadeViewSet, basename='unidade')
router.register('clientes', ClienteViewSet, basename='cliente')
router.register('fornecedores', FornecedorViewSet, basename='fornecedor')
router.register('vendedores', VendedorViewSet, basename='vendedor')
router.register('estoque', EstoqueViewSet, basename='estoque')
router.register('movimentacoes', MovimentacaoEstoqueViewSet, basename='movimentacao')
router.register('vendas', VendaViewSet, basename='venda')
router.register('comissoes', ComissaoViewSet, basename='comissao')
router.register('compras', CompraViewSet, basename='compra')
router.register('contas-pagar', ContaPagarViewSet, basename='conta-pagar')
router.register('contas-receber', ContaReceberViewSet, basename='conta-receber')
router.register('fluxo-caixa', FluxoCaixaViewSet, basename='fluxo-caixa')

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include(router.urls)),
    path('api-auth/', include('rest_framework.urls')),
    path('', include('core.urls')),
    path('integracao/', include('integracao.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

admin.site.site_header = 'Nevada & Montreal ERP'
admin.site.site_title = 'Grupo Montana'
admin.site.index_title = 'Administracao do Sistema'
