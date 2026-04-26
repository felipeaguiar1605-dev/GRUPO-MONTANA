from rest_framework import serializers, viewsets
from .models import Empresa, PerfilUsuario


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------

class EmpresaSerializer(serializers.ModelSerializer):
    class Meta:
        model = Empresa
        fields = '__all__'


class PerfilUsuarioSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True)
    full_name = serializers.CharField(source='user.get_full_name', read_only=True)

    class Meta:
        model = PerfilUsuario
        fields = '__all__'


# ---------------------------------------------------------------------------
# ViewSets
# ---------------------------------------------------------------------------

class EmpresaViewSet(viewsets.ModelViewSet):
    serializer_class = EmpresaSerializer

    def get_queryset(self):
        if hasattr(self.request.user, 'perfil'):
            return self.request.user.perfil.empresas.filter(ativa=True)
        return Empresa.objects.none()


class PerfilUsuarioViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = PerfilUsuarioSerializer

    def get_queryset(self):
        if self.request.user.is_staff:
            return PerfilUsuario.objects.all()
        return PerfilUsuario.objects.filter(user=self.request.user)
