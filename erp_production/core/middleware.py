from core.models import Empresa

class EmpresaMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.empresa = None
        if request.user.is_authenticated:
            empresa_id = request.session.get('empresa_id')
            if empresa_id:
                try:
                    request.empresa = Empresa.objects.get(id=empresa_id, ativa=True)
                except Empresa.DoesNotExist:
                    pass
            if not request.empresa and hasattr(request.user, 'perfil'):
                perfil = request.user.perfil
                if perfil.empresa_padrao:
                    request.empresa = perfil.empresa_padrao
                    request.session['empresa_id'] = perfil.empresa_padrao.id
                else:
                    primeira = perfil.empresas.filter(ativa=True).first()
                    if primeira:
                        request.empresa = primeira
                        request.session['empresa_id'] = primeira.id
        response = self.get_response(request)
        return response
