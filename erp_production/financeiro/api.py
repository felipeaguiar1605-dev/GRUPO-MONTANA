from rest_framework import serializers, viewsets
from .models import ContaPagar, ContaReceber, FluxoCaixa


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

class ContaPagarSerializer(serializers.ModelSerializer):
    fornecedor_nome = serializers.SerializerMethodField()
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = ContaPagar
        fields = '__all__'

    def get_fornecedor_nome(self, obj):
        if obj.fornecedor:
            return obj.fornecedor.nome_fantasia or obj.fornecedor.razao_social
        return ''


class ContaReceberSerializer(serializers.ModelSerializer):
    cliente_nome = serializers.CharField(source='cliente.nome', read_only=True, default='')
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = ContaReceber
        fields = '__all__'


class FluxoCaixaSerializer(serializers.ModelSerializer):
    tipo_display = serializers.CharField(source='get_tipo_display', read_only=True)

    class Meta:
        model = FluxoCaixa
        fields = '__all__'


# ---------------------------------------------------------------------------
# ViewSets
# ---------------------------------------------------------------------------

class ContaPagarViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = ContaPagar.objects.select_related('fornecedor').all()
    serializer_class = ContaPagarSerializer
    search_fields = ('descricao', 'fornecedor__razao_social', 'documento')
    filterset_fields = ('status',)


class ContaReceberViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = ContaReceber.objects.select_related('cliente').all()
    serializer_class = ContaReceberSerializer
    search_fields = ('descricao', 'cliente__nome', 'documento')
    filterset_fields = ('status',)


class FluxoCaixaViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = FluxoCaixa.objects.all()
    serializer_class = FluxoCaixaSerializer
    search_fields = ('descricao',)
    filterset_fields = ('tipo',)
