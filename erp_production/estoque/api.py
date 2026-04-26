from rest_framework import serializers, viewsets
from .models import Estoque, MovimentacaoEstoque


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

class EstoqueSerializer(serializers.ModelSerializer):
    produto_nome = serializers.CharField(source='produto.nome', read_only=True)
    produto_codigo = serializers.CharField(source='produto.codigo', read_only=True)
    abaixo_minimo = serializers.BooleanField(read_only=True)

    class Meta:
        model = Estoque
        fields = '__all__'


class MovimentacaoEstoqueSerializer(serializers.ModelSerializer):
    produto_nome = serializers.CharField(source='produto.nome', read_only=True)
    usuario_nome = serializers.CharField(source='usuario.get_full_name', read_only=True, default='')
    tipo_display = serializers.CharField(source='get_tipo_display', read_only=True)

    class Meta:
        model = MovimentacaoEstoque
        fields = '__all__'


# ---------------------------------------------------------------------------
# ViewSets
# ---------------------------------------------------------------------------

class EstoqueViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Estoque.objects.select_related('produto').all()
    serializer_class = EstoqueSerializer
    search_fields = ('produto__nome', 'produto__codigo')


class MovimentacaoEstoqueViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = MovimentacaoEstoque.objects.select_related('produto', 'usuario').all()
    serializer_class = MovimentacaoEstoqueSerializer
    search_fields = ('produto__nome', 'produto__codigo', 'observacao')
    filterset_fields = ('tipo',)
