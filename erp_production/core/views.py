from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.db.models import Sum, Count, Q, F
from django.utils import timezone
from datetime import timedelta
from .models import Empresa

def index(request):
    if request.user.is_authenticated:
        return redirect('dashboard')
    return redirect('login')

@login_required
def dashboard(request):
    if not request.empresa:
        return redirect('selecionar_empresa')

    emp = request.empresa
    hoje = timezone.now().date()
    inicio_mes = hoje.replace(day=1)

    from vendas.models import Venda
    from compras.models import Compra
    from financeiro.models import ContaPagar, ContaReceber
    from produtos.models import Produto
    from clientes.models import Cliente
    from estoque.models import Estoque

    # Stats
    vendas_mes = Venda.objects.filter(empresa=emp, data_venda__date__gte=inicio_mes).exclude(status='cancelada')
    compras_mes = Compra.objects.filter(empresa=emp, data_compra__date__gte=inicio_mes).exclude(status='cancelada')

    stats = {
        'vendas_total': vendas_mes.aggregate(t=Sum('total'))['t'] or 0,
        'vendas_count': vendas_mes.count(),
        'compras_total': compras_mes.aggregate(t=Sum('total'))['t'] or 0,
        'compras_count': compras_mes.count(),
        'a_pagar': ContaPagar.objects.filter(empresa=emp, status='pendente').aggregate(t=Sum('valor'))['t'] or 0,
        'a_pagar_count': ContaPagar.objects.filter(empresa=emp, status='pendente').count(),
        'a_receber': ContaReceber.objects.filter(empresa=emp, status='pendente').aggregate(t=Sum('valor'))['t'] or 0,
        'a_receber_count': ContaReceber.objects.filter(empresa=emp, status='pendente').count(),
        'total_produtos': Produto.objects.filter(empresa=emp, ativo=True).count(),
        'total_clientes': Cliente.objects.filter(empresa=emp, ativo=True).count(),
        'estoque_baixo': Estoque.objects.filter(empresa=emp, quantidade__lte=F('produto__estoque_minimo'), produto__estoque_minimo__gt=0).count(),
        'vencidas': ContaPagar.objects.filter(empresa=emp, status='pendente', data_vencimento__lt=hoje).count(),
    }

    vendas_recentes = Venda.objects.filter(empresa=emp).select_related('cliente')[:10]

    return render(request, 'core/dashboard.html', {'stats': stats, 'vendas_recentes': vendas_recentes})

@login_required
def trocar_empresa(request, empresa_id):
    if hasattr(request.user, 'perfil'):
        empresa = get_object_or_404(Empresa, id=empresa_id, ativa=True, usuarios=request.user.perfil)
        request.session['empresa_id'] = empresa.id
    return redirect(request.META.get('HTTP_REFERER', 'dashboard'))

@login_required
def selecionar_empresa(request):
    if not hasattr(request.user, 'perfil'):
        return redirect('login')
    empresas = request.user.perfil.empresas.filter(ativa=True)
    if request.method == 'POST':
        empresa_id = request.POST.get('empresa_id')
        if empresa_id:
            request.session['empresa_id'] = int(empresa_id)
            return redirect('dashboard')
    return render(request, 'core/selecionar_empresa.html', {'empresas': empresas})
