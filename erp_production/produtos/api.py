from rest_framework import serializers, viewsets
from .models import Categoria, Unidade, Produto


# ---------------------------------------------------------------------------
# Base mixin – filters querysets by request.empresa (set by middleware)
# ---------------------------------------------------------------------------

class EmpresaFilterMixin:
    """Filters any queryset containing an `empresa` FK by request.empresa."""

    def get_queryset(self):
        qs = super().get_queryset()
        if hasattr(self.request, 'empresa') and self.request.empresa:
            return qs.filter(empresa=self.request.empresa)
        return qs.none()


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------

class CategoriaSerializer(serializers.ModelSerializer):
    class Meta:
        model = Categoria
        fields = '__all__'


class UnidadeSerializer(serializers.ModelSerializer):
    class Meta:
        model = Unidade
        fields = '__all__'


class ProdutoSerializer(serializers.ModelSerializer):
    categoria_nome = serializers.CharField(source='categoria.nome', read_only=True, default='')
    unidade_sigla = serializers.CharField(source='unidade.sigla', read_only=True, default='')

    class Meta:
        model = Produto
        fields = '__all__'


# ---------------------------------------------------------------------------
# ViewSets
# ---------------------------------------------------------------------------

class CategoriaViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Categoria.objects.all()
    serializer_class = CategoriaSerializer
    search_fields = ('nome',)


class UnidadeViewSet(viewsets.ModelViewSet):
    """Unidade has no empresa FK – return all."""
    queryset = Unidade.objects.all()
    serializer_class = UnidadeSerializer
    search_fields = ('sigla', 'descricao')


class ProdutoViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Produto.objects.select_related('categoria', 'unidade').all()
    serializer_class = ProdutoSerializer
    search_fields = ('nome', 'codigo', 'codigo_barras')
    filterset_fields = ('categoria', 'ativo', 'ml_sync')
