from django.urls import path
from . import views

app_name = 'integracao'

urlpatterns = [
    path('', views.index, name='index'),
    path('mercadolivre/conectar/', views.ml_conectar, name='ml_conectar'),
    path('mercadolivre/callback/', views.ml_callback, name='ml_callback'),
    path('mercadolivre/sincronizar/produtos/', views.ml_sync_produtos, name='ml_sync_produtos'),
    path('mercadolivre/sincronizar/pedidos/', views.ml_sync_pedidos, name='ml_sync_pedidos'),
]
