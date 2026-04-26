import requests
from django.conf import settings
from django.utils import timezone
from datetime import timedelta


class MercadoLivreAPI:
    def __init__(self, integracao):
        self.integracao = integracao
        self.base_url = settings.ML_API_URL

    def _get_headers(self):
        self._check_token()
        return {'Authorization': f'Bearer {self.integracao.access_token}', 'Content-Type': 'application/json'}

    def _check_token(self):
        if timezone.now() >= self.integracao.token_expira:
            self._refresh_token()

    def _refresh_token(self):
        response = requests.post(f'{self.base_url}/oauth/token', json={
            'grant_type': 'refresh_token',
            'client_id': settings.ML_APP_ID,
            'client_secret': settings.ML_SECRET_KEY,
            'refresh_token': self.integracao.refresh_token,
        })
        data = response.json()
        self.integracao.access_token = data['access_token']
        self.integracao.refresh_token = data['refresh_token']
        self.integracao.token_expira = timezone.now() + timedelta(seconds=data['expires_in'])
        self.integracao.save()

    def get_user(self):
        r = requests.get(f'{self.base_url}/users/me', headers=self._get_headers())
        return r.json()

    def listar_anuncios(self, offset=0, limit=50):
        user_id = self.integracao.ml_user_id
        r = requests.get(f'{self.base_url}/users/{user_id}/items/search',
            headers=self._get_headers(), params={'offset': offset, 'limit': limit})
        return r.json()

    def get_anuncio(self, item_id):
        r = requests.get(f'{self.base_url}/items/{item_id}', headers=self._get_headers())
        return r.json()

    def criar_anuncio(self, data):
        r = requests.post(f'{self.base_url}/items', headers=self._get_headers(), json=data)
        return r.json()

    def atualizar_anuncio(self, item_id, data):
        r = requests.put(f'{self.base_url}/items/{item_id}', headers=self._get_headers(), json=data)
        return r.json()

    def atualizar_estoque(self, item_id, quantidade):
        return self.atualizar_anuncio(item_id, {'available_quantity': int(quantidade)})

    def atualizar_preco(self, item_id, preco):
        return self.atualizar_anuncio(item_id, {'price': float(preco)})

    def listar_pedidos(self, date_from=None, offset=0, limit=50):
        user_id = self.integracao.ml_user_id
        params = {'seller': user_id, 'offset': offset, 'limit': limit, 'sort': 'date_desc'}
        if date_from:
            params['order.date_created.from'] = date_from.isoformat() + 'T00:00:00.000-00:00'
        r = requests.get(f'{self.base_url}/orders/search', headers=self._get_headers(), params=params)
        return r.json()

    def get_pedido(self, order_id):
        r = requests.get(f'{self.base_url}/orders/{order_id}', headers=self._get_headers())
        return r.json()
