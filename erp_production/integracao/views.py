import requests
from django.shortcuts import render, redirect
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from django.conf import settings
from django.utils import timezone
from datetime import timedelta

from .models import IntegracaoMercadoLivre, PlataformaIntegracao, LogSincronizacao
from .mercadolivre import MercadoLivreAPI


@login_required
def index(request):
    if not request.empresa:
        return redirect('selecionar_empresa')

    ml_integracao = None
    try:
        ml_integracao = IntegracaoMercadoLivre.objects.get(empresa=request.empresa)
    except IntegracaoMercadoLivre.DoesNotExist:
        pass

    plataformas = PlataformaIntegracao.objects.filter(empresa=request.empresa)
    logs = LogSincronizacao.objects.filter(integracao__empresa=request.empresa)[:20]

    context = {
        'ml_integracao': ml_integracao,
        'plataformas': plataformas,
        'logs': logs,
        'ml_app_id': settings.ML_APP_ID,
    }
    return render(request, 'integracao/index.html', context)


@login_required
def ml_conectar(request):
    if not request.empresa:
        return redirect('selecionar_empresa')

    auth_url = (
        f"{settings.ML_AUTH_URL}/authorization"
        f"?response_type=code"
        f"&client_id={settings.ML_APP_ID}"
        f"&redirect_uri={settings.ML_REDIRECT_URI}"
        f"&state={request.empresa.id}"
    )
    return redirect(auth_url)


@login_required
def ml_callback(request):
    code = request.GET.get('code')
    state = request.GET.get('state')

    if not code:
        messages.error(request, 'Erro na autorizacao do Mercado Livre. Codigo nao recebido.')
        return redirect('integracao:index')

    # Exchange code for token
    try:
        response = requests.post(f'{settings.ML_API_URL}/oauth/token', json={
            'grant_type': 'authorization_code',
            'client_id': settings.ML_APP_ID,
            'client_secret': settings.ML_SECRET_KEY,
            'code': code,
            'redirect_uri': settings.ML_REDIRECT_URI,
        })
        data = response.json()

        if 'access_token' not in data:
            messages.error(request, f'Erro ao obter token: {data.get("message", "Erro desconhecido")}')
            return redirect('integracao:index')

        # Get user info
        user_response = requests.get(f'{settings.ML_API_URL}/users/me', headers={
            'Authorization': f'Bearer {data["access_token"]}'
        })
        user_data = user_response.json()

        # Save or update integration
        integracao, created = IntegracaoMercadoLivre.objects.update_or_create(
            empresa=request.empresa,
            defaults={
                'ml_user_id': str(user_data.get('id', '')),
                'nickname': user_data.get('nickname', ''),
                'access_token': data['access_token'],
                'refresh_token': data.get('refresh_token', ''),
                'token_expira': timezone.now() + timedelta(seconds=data.get('expires_in', 21600)),
                'ativa': True,
            }
        )

        messages.success(request, f'Mercado Livre conectado com sucesso! Conta: {user_data.get("nickname", "")}')

    except Exception as e:
        messages.error(request, f'Erro ao conectar com Mercado Livre: {str(e)}')

    return redirect('integracao:index')


@login_required
def ml_sync_produtos(request):
    if not request.empresa:
        return redirect('selecionar_empresa')

    try:
        integracao = IntegracaoMercadoLivre.objects.get(empresa=request.empresa, ativa=True)
    except IntegracaoMercadoLivre.DoesNotExist:
        messages.error(request, 'Integracao com Mercado Livre nao esta ativa.')
        return redirect('integracao:index')

    try:
        api = MercadoLivreAPI(integracao)
        resultado = api.listar_anuncios()
        total = resultado.get('paging', {}).get('total', 0)

        integracao.ultima_sincronizacao = timezone.now()
        integracao.save()

        # Log via PlataformaIntegracao if exists
        plataforma, _ = PlataformaIntegracao.objects.get_or_create(
            empresa=request.empresa,
            plataforma='mercadolivre',
            defaults={'ativa': True},
        )
        plataforma.ultima_sincronizacao = timezone.now()
        plataforma.save()

        LogSincronizacao.objects.create(
            integracao=plataforma,
            tipo='produtos',
            status='sucesso',
            registros_processados=total,
            detalhes=f'{total} anuncios encontrados no Mercado Livre.',
        )

        messages.success(request, f'Produtos sincronizados com sucesso! {total} anuncios encontrados.')

    except Exception as e:
        plataforma = PlataformaIntegracao.objects.filter(
            empresa=request.empresa, plataforma='mercadolivre'
        ).first()
        if plataforma:
            LogSincronizacao.objects.create(
                integracao=plataforma,
                tipo='produtos',
                status='erro',
                detalhes=str(e),
            )
        messages.error(request, f'Erro ao sincronizar produtos: {str(e)}')

    return redirect('integracao:index')


@login_required
def ml_sync_pedidos(request):
    if not request.empresa:
        return redirect('selecionar_empresa')

    try:
        integracao = IntegracaoMercadoLivre.objects.get(empresa=request.empresa, ativa=True)
    except IntegracaoMercadoLivre.DoesNotExist:
        messages.error(request, 'Integracao com Mercado Livre nao esta ativa.')
        return redirect('integracao:index')

    try:
        api = MercadoLivreAPI(integracao)

        # Sync orders from the last 30 days
        date_from = timezone.now().date() - timedelta(days=30)
        resultado = api.listar_pedidos(date_from=date_from)
        total = resultado.get('paging', {}).get('total', 0)

        integracao.ultima_sincronizacao = timezone.now()
        integracao.save()

        plataforma, _ = PlataformaIntegracao.objects.get_or_create(
            empresa=request.empresa,
            plataforma='mercadolivre',
            defaults={'ativa': True},
        )
        plataforma.ultima_sincronizacao = timezone.now()
        plataforma.save()

        LogSincronizacao.objects.create(
            integracao=plataforma,
            tipo='pedidos',
            status='sucesso',
            registros_processados=total,
            detalhes=f'{total} pedidos encontrados nos ultimos 30 dias.',
        )

        messages.success(request, f'Pedidos sincronizados com sucesso! {total} pedidos encontrados.')

    except Exception as e:
        plataforma = PlataformaIntegracao.objects.filter(
            empresa=request.empresa, plataforma='mercadolivre'
        ).first()
        if plataforma:
            LogSincronizacao.objects.create(
                integracao=plataforma,
                tipo='pedidos',
                status='erro',
                detalhes=str(e),
            )
        messages.error(request, f'Erro ao sincronizar pedidos: {str(e)}')

    return redirect('integracao:index')
