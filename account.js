        // 保存账号数据
        function saveData() {
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;

            if (!email || !password) {
                alert('请填写完整信息');
                return;
            }

            // 获取当前存储的账号数据
            const accounts = JSON.parse(localStorage.getItem('accounts')) || [];

            // 检查是否已存在相同的邮箱
            const existingAccount = accounts.find(account => account.email === email);
            if (existingAccount) {
                existingAccount.password = password; // 更新授权码
            } else {
                accounts.push({ email, password }); // 添加新账号
            }

            localStorage.setItem('accounts', JSON.stringify(accounts));
            alert('账号数据已保存');
            updateAccountSelect(); // 更新下拉框
        }

        // 加载选中的账号数据
        function loadData() {
            const accountSelect = document.getElementById('account-select');
            const selectedEmail = accountSelect.value;

            if (!selectedEmail) {
                alert('请先选择账号');
                return;
            }

            const accounts = JSON.parse(localStorage.getItem('accounts')) || [];
            const selectedAccount = accounts.find(account => account.email === selectedEmail);

            if (selectedAccount) {
                document.getElementById('email').value = selectedAccount.email;
                document.getElementById('password').value = selectedAccount.password;
                alert('账号数据已加载');
            } else {
                alert('未找到对应的账号数据');
            }
        }

        // 更新下拉框的选项
        function updateAccountSelect() {
            const accounts = JSON.parse(localStorage.getItem('accounts')) || [];
            const accountSelect = document.getElementById('account-select');

            // 清空当前选项
            accountSelect.innerHTML = '<option value="" disabled selected>请选择账号</option>';

            accounts.forEach(account => {
                const option = document.createElement('option');
                option.value = account.email;
                option.textContent = account.email;
                accountSelect.appendChild(option);
            });
        }

        // 切换选择的账号时加载数据到输入框
        function selectAccount() {
            const accountSelect = document.getElementById('account-select');
            const selectedEmail = accountSelect.value;

            const accounts = JSON.parse(localStorage.getItem('accounts')) || [];
            const selectedAccount = accounts.find(account => account.email === selectedEmail);

            if (selectedAccount) {
                document.getElementById('email').value = selectedAccount.email;
                document.getElementById('password').value = selectedAccount.password;
            }
        }

        // 初始化下拉框
        window.onload = updateAccountSelect;


        // 改变模板
        const templates = [
            "通用.html",
            "二次开发.html",
        ];
        
        function loadTemplates() {
            const templateSelect = document.getElementById("template-select");
        
            templates.forEach(template => {
                const option = document.createElement("option");
                option.value = `template/${template}`;
                option.textContent = template.replace('.html', ''); // 去掉扩展名
                templateSelect.appendChild(option);
            });
        }
        
        function changeTemplate() {
            const templateSelect = document.getElementById("template-select");
            const selectedTemplate = templateSelect.value;
        
            if (selectedTemplate) {
                document.getElementById("email-preview").src = selectedTemplate;
            }
        }
        
        document.addEventListener("DOMContentLoaded", loadTemplates);
        