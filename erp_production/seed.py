#!/usr/bin/env python3
import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Empresa, PerfilUsuario
from produtos.models import Unidade
from django.contrib.auth.models import User

# Empresas
e1, _ = Empresa.objects.get_or_create(
    cnpj='00.000.000/0001-01',
    defaults={
        'razao_social': 'Nevada Embalagens e Produtos de Limpeza LTDA',
        'nome_fantasia': 'Nevada Embalagens',
        'tipo': 'ambos',
        'estado': 'GO',
    }
)
e2, _ = Empresa.objects.get_or_create(
    cnpj='00.000.000/0001-02',
    defaults={
        'razao_social': 'Montreal Maquinas e Ferramentas LTDA',
        'nome_fantasia': 'Montreal Maquinas',
        'tipo': 'ambos',
        'estado': 'GO',
    }
)
print(f'Empresas: {e1.nome_fantasia}, {e2.nome_fantasia}')

# Vincular admin
u = User.objects.filter(username='admin').first()
if u:
    p, _ = PerfilUsuario.objects.get_or_create(
        user=u,
        defaults={'perfil': 'admin', 'empresa_padrao': e1}
    )
    p.empresas.add(e1, e2)
    print(f'Admin vinculado a ambas empresas')

# Unidades
unidades = [
    ('UN', 'Unidade'), ('PC', 'Peca'), ('CX', 'Caixa'), ('PCT', 'Pacote'),
    ('FD', 'Fardo'), ('KG', 'Quilograma'), ('LT', 'Litro'), ('MT', 'Metro'),
    ('M2', 'Metro Quadrado'), ('GL', 'Galao'), ('RL', 'Rolo'), ('SC', 'Saco'),
    ('DZ', 'Duzia'), ('PR', 'Par'), ('JG', 'Jogo'),
]
for sigla, desc in unidades:
    Unidade.objects.get_or_create(sigla=sigla, defaults={'descricao': desc})
print(f'{len(unidades)} unidades cadastradas')

print('Seed completo!')
