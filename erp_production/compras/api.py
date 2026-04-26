from rest_framework import serializers, viewsets
from .models import Compra, CompraItem


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

class CompraItemSerializer(serializers.ModelSerializer):
    produto_nome = serializers.CharField(source='produto.nome', read_only=True)
    produto_codigo = serializers.CharField(source='produto.codigo', read_only=True)

    class Meta:
        model = CompraItem
        fields = '__all__'


class CompraSerializer(serializers.ModelSerializer):
    itens = CompraItemSerializer(many=True, read_only=True)
    fornecedor_nome = serializers.SerializerMethodField()
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = Compra
        fields = '__all__'

    def get_fornecedor_nome(self, obj):
        if obj.fornecedor:
            return obj.fornecedor.nome_fantasia or obj.fornecedor.razao_social
        return ''


# ---------------------------------------------------------------------------
# ViewSets
# ---------------------------------------------------------------------------

class CompraViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Compra.objects.select_related('fornecedor', 'usuario').prefetch_related('itens__produto').all()
    serializer_class = CompraSerializer
    search_fields = ('numero', 'fornecedor__razao_social', 'nfe_chave')
    filterset_fields = ('status',)
