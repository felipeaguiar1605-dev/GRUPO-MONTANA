from rest_framework import serializers, viewsets
from .models import Cliente, Fornecedor, Vendedor


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

class ClienteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Cliente
        fields = '__all__'


class FornecedorSerializer(serializers.ModelSerializer):
    class Meta:
        model = Fornecedor
        fields = '__all__'


class VendedorSerializer(serializers.ModelSerializer):
    class Meta:
        model = Vendedor
        fields = '__all__'


# ---------------------------------------------------------------------------
# ViewSets
# ---------------------------------------------------------------------------

class ClienteViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Cliente.objects.all()
    serializer_class = ClienteSerializer
    search_fields = ('nome', 'cpf_cnpj', 'email', 'telefone')
    filterset_fields = ('tipo_pessoa', 'ativo')


class FornecedorViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Fornecedor.objects.all()
    serializer_class = FornecedorSerializer
    search_fields = ('razao_social', 'nome_fantasia', 'cnpj', 'email')
    filterset_fields = ('ativo',)


class VendedorViewSet(EmpresaFilterMixin, viewsets.ModelViewSet):
    queryset = Vendedor.objects.all()
    serializer_class = VendedorSerializer
    search_fields = ('nome', 'cpf', 'email')
    filterset_fields = ('ativo',)
