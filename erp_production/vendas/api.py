from rest_framework import serializers, viewsets
from .models import Venda, VendaItem, Comissao


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

class VendaItemSerializer(serializers.ModelSerializer):
    produto_nome = serializers.CharField(source='produto.nome', read_only=True)
    produto_codigo = serializers.CharField(source='produto.codigo', read_only=True)

    class Meta:
        model = VendaItem
        fields = '__all__'


class VendaSerializer(serializers.ModelSerializer):
    itens = VendaItemSerializer(many=True, read_only=True)
    cliente_nome = serializers.CharField(source='cliente.nome', read_only=True, default='')
    vendedor_nome = serializers.CharField(source='vendedor.nome', read_only=True, default='')
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    forma_pagamento_display = serializers.CharField(source='get_forma_pagamento_display', read_only=True)

    class Meta:
        model = Venda
        fields = '__all__'


class ComissaoSerializer(serializers.ModelSerializer):
    vendedor_nome = serializers.CharField(source='vendedor.nome', read_only=True)
    venda_numero = serializers.CharField(source='venda.numero', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = Comissao
        fields = '__all__'


# ---------------------------------------------------------------------------
# ViewSets
# ---------------------------------------------------------------------------

class VendaViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Venda.objects.select_related('cliente', 'vendedor', 'usuario').prefetch_related('itens__produto').all()
    serializer_class = VendaSerializer
    search_fields = ('numero', 'cliente__nome', 'vendedor__nome')
    filterset_fields = ('status', 'forma_pagamento')


class ComissaoViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Comissao.objects.select_related('vendedor', 'venda').all()
    serializer_class = ComissaoSerializer
    search_fields = ('vendedor__nome', 'venda__numero')
    filterset_fields = ('status',)
