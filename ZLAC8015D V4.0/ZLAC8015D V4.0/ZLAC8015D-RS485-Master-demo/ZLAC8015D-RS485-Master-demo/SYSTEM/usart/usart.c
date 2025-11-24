#include "sys.h"
#include "usart.h"
#include "delay.h"
////////////////////////////////////////////////////////////////////////////////// 	 
//初始化IO 串口1 
//bound:波特率
/*串口1配置函数*/

//接收缓存区 	
u8 RS485_RX_BUF[64];  	//接收缓冲,最大64个字节.
//接收到的数据长度
u8 RS485_RX_CNT=0; 

void USART2_Configuration(void)
{
	GPIO_InitTypeDef GPIO_InitStructure;//GPIO配置结构体
	USART_InitTypeDef USART_InitStructure;//串口配置结构体
  NVIC_InitTypeDef NVIC_InitStructure;
	/*使能使用的外设时钟*/
	RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA | RCC_APB2Periph_AFIO, ENABLE);
	RCC_APB1PeriphClockCmd(RCC_APB1Periph_USART2, ENABLE);
	/*GPIOA_Pin_10----USART3_Tx发送端*/
	GPIO_InitStructure.GPIO_Pin = GPIO_Pin_2;
	GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AF_PP;//复用推挽输出
	GPIO_InitStructure.GPIO_Speed = GPIO_Speed_50MHz;
	GPIO_Init(GPIOA, &GPIO_InitStructure);
	/*GPIOA_Pin_11----USART3_Rx接收端*/
	GPIO_InitStructure.GPIO_Pin = GPIO_Pin_3;
	GPIO_InitStructure.GPIO_Mode = GPIO_Mode_IN_FLOATING;//浮空输入
	GPIO_Init(GPIOA, &GPIO_InitStructure);
	/*GPIOA_Pin_0----收发使能端，0接收，1发送*/
	GPIO_InitStructure.GPIO_Pin = GPIO_Pin_4;
	GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_PP ;
	GPIO_Init(GPIOA, &GPIO_InitStructure);//初始化485方向控制引脚
	GPIO_ResetBits(GPIOA,GPIO_Pin_4);//使其初始化为接收允许*/
//	GPIO_SetBits(GPIOA,GPIO_Pin_0);
	
//	NVIC_Configuration(4);
	
	/*USART1通信配置*/
	USART_InitStructure.USART_BaudRate = 115200;//波特率为115200
	USART_InitStructure.USART_WordLength = USART_WordLength_8b;//8位数据位
	USART_InitStructure.USART_StopBits = USART_StopBits_1;//1位停止位
	USART_InitStructure.USART_Parity = USART_Parity_No;//无奇偶校验
	USART_InitStructure.USART_HardwareFlowControl = USART_HardwareFlowControl_None;//无硬件流控制
	USART_InitStructure.USART_Mode = USART_Mode_Rx | USART_Mode_Tx;//发送与接收模式

	USART_Init(USART2, &USART_InitStructure); //初始化串口1
	
	USART_ITConfig(USART2,USART_IT_RXNE,ENABLE);//使能串口1接收中断
	USART_ITConfig(USART2,USART_IT_TXE,DISABLE);//关闭串口1发送中断
	
	USART_Cmd(USART2, ENABLE);//使能串口1
	
//	NVIC_PriorityGroupConfig(NVIC_PriorityGroup_4);
//  //设定USART3 中断优先级
//  NVIC_InitStructure.NVIC_IRQChannel = USART2_IRQn;
//  NVIC_InitStructure.NVIC_IRQChannelPreemptionPriority = 1;
//  NVIC_InitStructure.NVIC_IRQChannelSubPriority = 0;
//  NVIC_InitStructure.NVIC_IRQChannelCmd = ENABLE;
//  NVIC_Init(&NVIC_InitStructure);
}

/*发送一个字符*/
void usart_sent_char(USART_TypeDef* USARTx,u8 ch )
{  
	   USART_SendData( USARTx,ch);
	   while(USART_GetFlagStatus(USARTx, USART_FLAG_TXE) == RESET);
	   USART_ClearFlag(USARTx, USART_FLAG_TXE);
} 

/*发送一个字符串*/
void usart_sent_string(USART_TypeDef* USARTx,char *ch)
{
	while(*ch!='\0')
	{
		usart_sent_char( USARTx,*ch );
		ch++;
	}
}
void TIM2_Configuration(void) //用于Modbus通信的3.5T
{
	TIM_TimeBaseInitTypeDef  TIM_TimeBaseStructure;
	/*初始化为默认值*/
	TIM_DeInit(TIM2);
	//	TIM_InternalClockConfig(TIM2);	
		/* TIM2 clock enable */
	RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM2, ENABLE);

//	NVIC_Configuration(3);
	/* TIM2做定时器，基础设置*/
	/*T=3.5*( 1 +数据位+奇偶校验+ 停止位)/ 波特率
	t=3.5*（1+8+0+1）/波特率
	由于t1.5 和 t3.5 的定时，隐含着大量的对中断的管理.在高通信速率下，这导致CPU 负担加
	重。因此，在通信速率等于或低于19200 Bps 时，这两个定时必须严格遵守；对于波特率大于
	19200 Bps 的情形，应该使用2 个定时的固定值：建议的字符间超时时间(t1.5)为750μs，
	帧间的超时时间(t1.5) 为1.750ms。*/
	TIM_TimeBaseStructure.TIM_Period = 2000;		               //计数值:175 定时1750us 19200 3.5个字符长度
	TIM_TimeBaseStructure.TIM_Prescaler =720-1;    	               //预分频,除数:720, 10us
	TIM_TimeBaseStructure.TIM_ClockDivision = 0;  	           //时钟分频因子为1
	TIM_TimeBaseStructure.TIM_CounterMode = TIM_CounterMode_Up;    //向上计数
	TIM_TimeBaseInit(TIM2, &TIM_TimeBaseStructure);	               // Time base configuration

	/*预先清除更新中断位*/
	TIM_ARRPreloadConfig(TIM2, ENABLE);//使能预装载
	TIM_ClearFlag(TIM2, TIM_FLAG_Update);

	//	TIM_ClearITPendingBit(TIM2, TIM_IT_Update);
	//TIM_SetCounter(TIM2, 0);

	/* 配置溢出中断*/
	TIM_ITConfig(TIM2, TIM_IT_Update, ENABLE); //允许更新中断
	TIM_Cmd(TIM2,ENABLE); 
}

//RS485发送len个字节.
//buf:发送区首地址
//len:发送的字节数(为了和本代码的接收匹配,这里建议不要超过64个字节)
void RS485_Send_Data(u8 *buf,u8 len)
{
	u8 t;
//	RS485_TX_EN=1;			//设置为发送模式
	RS485_TX_MODE();
  	for(t=0;t<len;t++)		//循环发送数据
	{		   
		while(USART_GetFlagStatus(USART2, USART_FLAG_TC) == RESET);	  
		USART_SendData(USART2,buf[t]);
	}	 
 
	while(USART_GetFlagStatus(USART2, USART_FLAG_TC) == RESET);		
	RS485_RX_CNT=0;	
  RS485_RX_MODE();  
//	RS485_TX_EN=0;				//设置为接收模式	
}
//RS485查询接收到的数据
//buf:接收缓存首地址
//len:读到的数据长度
void RS485_Receive_Data(u8 *buf,u8 *len)
{
	u8 rxlen=RS485_RX_CNT;
	u8 i=0;
	*len=0;				//默认为0
	delay_ms(1);		//等待10ms,连续超过10ms没有接收到一个数据,则认为接收结束
	if(rxlen==RS485_RX_CNT&&rxlen)//接收到了数据,且接收完成了
	{
		for(i=0;i<rxlen;i++)
		{
			buf[i]=RS485_RX_BUF[i];	
		}		
		*len=RS485_RX_CNT;	//记录本次数据长度
		RS485_RX_CNT=0;		//清零
	}
}
void USART2_IRQHandler(void)
{	
 	u8 res;	    
 
 	if(USART_GetITStatus(USART2, USART_IT_RXNE) != RESET) //接收到数据
	{	 
	 			 
		res =USART_ReceiveData(USART2); 	//读取接收到的数据
		if(RS485_RX_CNT<64)
		{
			RS485_RX_BUF[RS485_RX_CNT]=res;		//记录接收到的值
			RS485_RX_CNT++;						//接收数据增加1 
		} 
	} 
}
