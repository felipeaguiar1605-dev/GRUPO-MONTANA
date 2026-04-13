// ERP Nevada & Montreal - Scripts globais

// Trocar empresa via select no header
function trocarEmpresa(selectEl) {
    const id = selectEl.value;
    if (id) window.location.href = '/trocar-empresa/' + id;
}

// Toggle sidebar mobile
function toggleSidebar() {
    document.querySelector('.sidebar').classList.toggle('open');
}

// Abrir/fechar modal
function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

// Fechar modal ao clicar fora
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('active');
    }
});

// Confirmar exclusão
function confirmarExclusao(url, nome) {
    if (confirm('Tem certeza que deseja excluir "' + nome + '"?')) {
        window.location.href = url;
    }
}

// Formatar moeda ao digitar
function formatMoney(input) {
    let val = input.value.replace(/\D/g, '');
    val = (parseInt(val || 0) / 100).toFixed(2);
    input.value = val;
}

// Máscara CPF/CNPJ
function maskCpfCnpj(input) {
    let val = input.value.replace(/\D/g, '');
    if (val.length <= 11) {
        val = val.replace(/(\d{3})(\d)/, '$1.$2');
        val = val.replace(/(\d{3})(\d)/, '$1.$2');
        val = val.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    } else {
        val = val.replace(/^(\d{2})(\d)/, '$1.$2');
        val = val.replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');
        val = val.replace(/\.(\d{3})(\d)/, '.$1/$2');
        val = val.replace(/(\d{4})(\d)/, '$1-$2');
    }
    input.value = val;
}

// Máscara telefone
function maskTelefone(input) {
    let val = input.value.replace(/\D/g, '');
    if (val.length <= 10) {
        val = val.replace(/(\d{2})(\d)/, '($1) $2');
        val = val.replace(/(\d{4})(\d)/, '$1-$2');
    } else {
        val = val.replace(/(\d{2})(\d)/, '($1) $2');
        val = val.replace(/(\d{5})(\d)/, '$1-$2');
    }
    input.value = val;
}

// Máscara CEP
function maskCep(input) {
    let val = input.value.replace(/\D/g, '');
    val = val.replace(/(\d{5})(\d)/, '$1-$2');
    input.value = val;
}

// Calcular margem/markup
function calcularPrecoVenda() {
    const custo = parseFloat(document.getElementById('preco_custo')?.value || 0);
    const margem = parseFloat(document.getElementById('margem_lucro')?.value || 0);
    const precoVendaInput = document.getElementById('preco_venda');
    if (custo > 0 && margem > 0 && precoVendaInput) {
        precoVendaInput.value = (custo * (1 + margem / 100)).toFixed(2);
    }
}

// Auto-submit search com delay
let searchTimer;
function searchDebounce(input, formId) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        document.getElementById(formId).submit();
    }, 500);
}

// Alerta auto-dismiss
document.addEventListener('DOMContentLoaded', () => {
    const alerts = document.querySelectorAll('.alert[data-dismiss]');
    alerts.forEach(alert => {
        setTimeout(() => {
            alert.style.opacity = '0';
            alert.style.transition = 'opacity 0.3s';
            setTimeout(() => alert.remove(), 300);
        }, 4000);
    });
});
