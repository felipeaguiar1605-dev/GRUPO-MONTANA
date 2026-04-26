def empresa_context(request):
    ctx = {'empresa_atual': getattr(request, 'empresa', None), 'empresas_usuario': []}
    if request.user.is_authenticated and hasattr(request.user, 'perfil'):
        ctx['empresas_usuario'] = request.user.perfil.empresas.filter(ativa=True)
    return ctx
