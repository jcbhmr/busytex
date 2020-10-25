//TODO: work with only files paths (without dir paths)
//TODO: what happens if creating another pipeline (waiting data error?)
//TODO: terminate pipeline correctly?
//TODO: TEXMFLOG?

class BusytexPipeline
{
    static VerboseSilent = 'silent';
    static VerboseInfo = 'info';
    static VerboseDebug = 'debug';

    static preRun = [];
    static data_packages = [];
    
    static locateFile(remote_package_name)
    {
        for(const data_package_js of BusytexPipeline.data_packages)
        {
            const data_file = data_package_js.replace('.js', '.data');
            if(data_file.endsWith(remote_package_name))
                return data_file;
        }
        return null;
    }

    static ScriptLoaderDocument(src)
    {
        return new Promise((resolve, reject) =>
        {
            let s = self.document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            self.document.head.appendChild(s);
        });
    }

    static ScriptLoaderRequire(src)
    {
        return new Promise(resolve => self.require([src], resolve));
    }

    static ScriptLoaderWorker(src)
    {
        return Promise.resolve(self.importScripts(src));
    }

    constructor(busytex_js, busytex_wasm, texlive_js, texmf_local, print, script_loader, preload)
    {
        this.print = print;
        this.preload = preload;
        this.wasm_module_promise = fetch(busytex_wasm).then(WebAssembly.compileStreaming);
        this.em_module_promise = script_loader(busytex_js);
        
        BusytexPipeline.data_packages = []
        for(const data_package_js of texlive_js)
        {
            this.em_module_promise = this.em_module_promise.then(_ => script_loader(data_package_js));
            BusytexPipeline.data_packages.push(data_package_js);
        }
        
        this.ansi_reset_sequence = '\x1bc';
        
        this.mem_header_size = 2 ** 25;
        this.project_dir = '/home/web_user/project_dir/';
        this.bin_busytex = '/bin/busytex';
        this.fmt_latex = '/latex.fmt';
        this.dir_texmfdist = ['/texlive', '/texmf', ...texmf_local].map(texmf => (texmf.startsWith('/') ? '' : this.project_dir) + texmf + '/texmf-dist').join(':');
        this.cnf_texlive = '/texmf.cnf';
        this.dir_cnf = '/';
        this.env = {TEXMFDIST : this.dir_texmfdist, TEXMFCNF : this.dir_cnf};

        this.Module = this.preload ? this.reload_module(this.env, this.project_dir) : null;
    }

    terminate()
    {
        this.Module = null;
    }

    async reload_module(env, project_dir)
    {
        const [wasm_module, em_module] = await Promise.all([this.wasm_module_promise, this.em_module_promise]);
        const {print, init_env} = this;
        const Module =
        {
            thisProgram : this.bin_busytex,
            noInitialRun : true,
            totalDependencies: 0,
            prefix : "",
            
            preRun : [() =>
            {
                Object.setPrototypeOf(BusytexPipeline, Module);
                self.LZ4 = Module.LZ4;
                for(const preRun of BusytexPipeline.preRun) 
                    preRun();

                for(const k in env)
                    Module.ENV[k] = env[k];

                Module.FS.mkdir(project_dir);
            }],

            instantiateWasm(imports, successCallback)
            {
                WebAssembly.instantiate(wasm_module, imports).then(successCallback);
            },
            
            print(text) 
            {
                if(verbose == BusytexVerboseSilent)
                    return;

                Module.setStatus(Module.prefix + ' | stdout: ' + (arguments.length > 1 ?  Array.prototype.slice.call(arguments).join(' ') : text));
            },

            printErr(text)
            {
                Module.setStatus(Module.prefix + ' | stderr: ' + (arguments.length > 1 ?  Array.prototype.slice.call(arguments).join(' ') : text));
            },
            
            setPrefix(text)
            {
                this.prefix = text;
            },
            
            setStatus(text)
            {
                print((this.statusPrefix || '') + text);
            },
            
            monitorRunDependencies(left)
            {
                this.totalDependencies = Math.max(this.totalDependencies, left);
                Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
            },
        };
       
        const initialized_module = await busytex(Module);
        console.assert(this.mem_header_size % 4 == 0 && initialized_module.HEAP32.slice(this.mem_header_size / 4).every(x => x == 0));
        return initialized_module;
    }

    async compile(files, main_tex_path, bibtex, verbose)
    {
        const NOCLEANUP_callMain = (Module, args) =>
        {
            Module.setPrefix(args[0]);
            const entryFunction = Module['_main'];
            const argc = args.length+1;
            const argv = Module.stackAlloc((argc + 1) * 4);
            Module.HEAP32[argv >> 2] = Module.allocateUTF8OnStack(Module.thisProgram);
            for (let i = 1; i < argc; i++) 
                Module.HEAP32[(argv >> 2) + i] = Module.allocateUTF8OnStack(args[i - 1]);
            Module.HEAP32[(argv >> 2) + argc] = 0;

            try
            {
                entryFunction(argc, argv);
            }
            catch(e)
            {
                this.print('callMain: ' + e.message);
                return e.status;
            }
            
            return 0;
        }
        
        if(this.Module == null)
            this.Module = this.reload_module(this.env, this.project_dir);
        
        const Module = await this.Module;
        const [FS, PATH] = [Module.FS, Module.PATH];

        const source_name = main_tex_path.slice(main_tex_path.lastIndexOf('/') + 1);

        const tex_path = source_name;
        const xdv_path = tex_path.replace('.tex', '.xdv');
        const pdf_path = tex_path.replace('.tex', '.pdf');
        const log_path = tex_path.replace('.tex', '.log');
        const aux_path = tex_path.replace('.tex', '.aux');

        const verbose_args = 
        {
            [BusytexPipeline.VerboseSilent] : {
                xetex : [],
                bibtex8 : [],
                xdvipdfmx : []
            },
            [BusytexPipeline.VerboseInfo] : {
                xetex: ['-kpathsea-debug', '32'],
                bibtex8 : ['--debug', 'search'],
                xdvipdfmx : ['-v'],
            },
            [BusytexPipeline.VerboseDebug] : {
                xetex : ['-recorder', '-kpathsea-debug', '63'],
                bibtex8 : ['--debug', 'all'],
                xdvipdfmx : ['-vv'],
            },
            '' : {
                xetex : [],
                bibtex8 : [],
                xdvipdfmx : []
            }
        };
        const xetex = ['xetex', '--interaction=nonstopmode', '--halt-on-error', '--no-pdf', '--fmt', this.fmt_latex, tex_path].concat((verbose_args[verbose] || verbose_args['']).xetex);
        const bibtex8 = ['bibtex8', '--8bit', aux_path].concat((verbose_args[verbose] || verbose_args['']).bibtex8);
        const xdvipdfmx = ['xdvipdfmx', '-o', pdf_path, xdv_path].concat((verbose_args[verbose] || verbose_args['']).xdvipdfmx);

        FS.mount(Module.MEMFS, {}, this.project_dir)
        const dirname = main_tex_path.slice(0, main_tex_path.length - source_name.length) || '.';
        const source_dir = PATH.join2(this.project_dir, dirname);
        for(const {path, contents} of files.sort((lhs, rhs) => lhs['path'] < rhs['path'] ? -1 : 1))
        {
            const absolute_path = PATH.join2(this.project_dir, path);
            if(contents == null)
                FS.mkdir(absolute_path);
            else
                FS.writeFile(absolute_path, contents);
        }
        FS.chdir(source_dir);
       
        const mem_header = Uint8Array.from(Module.HEAPU8.slice(0, this.mem_header_size));

        if(bibtex == null)
            bibtex = files.some(({path, contents}) => contents != null && path.endsWith('.bib'));
        const cmds = bibtex == true ? [xetex, bibtex8, xetex, xetex, xdvipdfmx] : [xetex, xdvipdfmx];
        
        this.print(this.ansi_reset_sequence);
        this.print(`New compilation started: [${main_tex_path}]`);
        let exit_code = 0;
        for(let i = 0; i < cmds.length; i++)
        {
            exit_code = NOCLEANUP_callMain(Module, cmds[i], this.print);
            Module.HEAPU8.fill(0);
            Module.HEAPU8.set(mem_header);
            
            Module.setStatus(`EXIT_CODE: ${exit_code}`);
            if(exit_code != 0)
                break;
        }

        const pdf = exit_code == 0 && FS.analyzePath(pdf_path).exists ? FS.readFile(pdf_path, {encoding: 'binary'}) : null;
        const log = FS.analyzePath(log_path).exists ? FS.readFile(log_path, {encoding : 'utf8'}) : null;
        
        FS.unmount(this.project_dir);
        if(!this.preload)
            this.Module = null;
        
        return {pdf : pdf, log : log};
    }
}
