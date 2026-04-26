.PHONY: install migrate run setup superuser

install:
	pip install -r requirements.txt

migrate:
	python manage.py makemigrations core clientes produtos estoque vendas compras financeiro integracao
	python manage.py migrate

run:
	python manage.py runserver 0.0.0.0:8000

setup: install migrate superuser
	@echo "Setup completo! Acesse http://localhost:8000"

superuser:
	DJANGO_SUPERUSER_PASSWORD=admin123 python manage.py createsuperuser --noinput --username admin --email admin@grupo.com 2>/dev/null || true

seed:
	python manage.py shell -c "\
from core.models import Empresa, PerfilUsuario; \
from django.contrib.auth.models import User; \
e1, _ = Empresa.objects.get_or_create(cnpj='00.000.000/0001-01', defaults={'razao_social': 'Nevada Embalagens e Produtos de Limpeza LTDA', 'nome_fantasia': 'Nevada Embalagens', 'tipo': 'ambos', 'estado': 'GO'}); \
e2, _ = Empresa.objects.get_or_create(cnpj='00.000.000/0001-02', defaults={'razao_social': 'Montreal Maquinas e Ferramentas LTDA', 'nome_fantasia': 'Montreal Maquinas', 'tipo': 'ambos', 'estado': 'GO'}); \
u = User.objects.filter(username='admin').first(); \
if u: p, _ = PerfilUsuario.objects.get_or_create(user=u, defaults={'perfil': 'admin', 'empresa_padrao': e1}); p.empresas.add(e1, e2); \
print('Seed completo: Nevada + Montreal + Admin vinculado')"

seed-unidades:
	python manage.py shell -c "\
from produtos.models import Unidade; \
unidades = [('UN','Unidade'),('PC','Peca'),('CX','Caixa'),('PCT','Pacote'),('FD','Fardo'),('KG','Quilograma'),('LT','Litro'),('MT','Metro'),('M2','Metro Quadrado'),('GL','Galao'),('RL','Rolo'),('SC','Saco'),('DZ','Duzia'),('PR','Par'),('JG','Jogo')]; \
[Unidade.objects.get_or_create(sigla=s, defaults={'descricao': d}) for s, d in unidades]; \
print('Unidades cadastradas')"
